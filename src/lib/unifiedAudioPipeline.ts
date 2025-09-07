// Unified Audio Pipeline - Single source of truth for all audio and speech recognition
// Consolidates: AudioManager, LegacyAudioManager, BargeInDetector, ASRManager, TTSPlayer

import { info, warn, error, debug } from './logger';
import { createEnhancedSpeech, type EnhancedSpeechControls, getASRInterimFlag, notifyTTSStart, notifyTTSEndOrBargeIn, resetHeldFinalState } from './speech/enhancedSpeech';
import { setMuted, setDispatcherTtsPlaying, cancelDispatcherPending } from './messageDispatcher';
import { emitHeld } from './speech/enhancedSpeech';
import { useState, useEffect } from 'react';

export interface UnifiedAudioPipelineConfig {
  onBargeIn?: () => void;
  onTTSStart?: (turnId: string) => void;
  onTTSEnd?: (turnId: string) => void;
  onTTSError?: (error: Error) => void;
  onMicTrackReady?: (track: MediaStreamTrack) => void;
  onFinalResult?: (text: string, confidence?: number) => void;
  onError?: (error: Error) => void;
  isTestPipeline?: boolean; // Added for testing
}

// Runtime barge mode selector (legacy | v2)
function detectBargeMode(): 'legacy' | 'v2' {
  try {
    const urlMode = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('bargeMode') : '';
    const lsMode = typeof window !== 'undefined' ? (window.localStorage.getItem('bargeMode') || '') : '';
    const envMode = (process.env.NEXT_PUBLIC_BARGE_MODE || '').toLowerCase();
    const picked = (urlMode || lsMode || envMode || 'legacy').toLowerCase();
    return picked === 'v2' ? 'v2' : 'legacy';
  } catch {
    return 'legacy';
  }
}

// Single source of truth via env, fallback to detector
const BARGE_PATH = (process.env.NEXT_PUBLIC_BARGE_PATH || detectBargeMode()) as 'legacy' | 'v2';
const BARGE_ON_ASR = ((process.env.NEXT_PUBLIC_BARGE_ON_ASR ?? '1') === '1');
export const bargeMode = BARGE_PATH;
try { info('AUDIO', `BARGE PATH: ${BARGE_PATH}`); } catch {}
try { console.info('[BARTEST] build=' + new Date().toISOString()); } catch {}

// v2 constants/state
const ARM_MS = 300, MIN_DB = -48, DELTA_DB = 10, BURST_MS = 180, SUSTAIN_MS = 120, VAD_MS = 180;
let bargeEnabled = false; let ttsStartAt = 0; let bargeInArmAllowedAt = 0; let micBurstSince: number | null = null; let decisionSince: number | null = null;

function getRmsDb(analyser?: AnalyserNode): number {
  if (!analyser) return Number.NaN;
  const N = analyser.fftSize || 2048; const buf = new Float32Array(N);
  try { (analyser as any).getFloatTimeDomainData(buf); } catch { return Number.NaN; }
  let sum = 0; for (let i = 0; i < N; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / N) || 1e-9; return 20 * Math.log10(rms);
}

export class UnifiedAudioPipeline {
  private audioContext: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private _micTrack: MediaStreamTrack | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micAnalyzer: AnalyserNode | null = null;
  private micHighpass: BiquadFilterNode | null = null;
  private micLowpass: BiquadFilterNode | null = null;
  private aiSource: MediaStreamAudioSourceNode | null = null;
  private aiAnalyser: AnalyserNode | null = null;
  private ttsEl: HTMLAudioElement | null = null;
  private ttsAudioEndedHandler: ((ev: Event) => void) | null = null;
  private ttsAudioErrorHandler: ((ev: Event) => void) | null = null;
  private ttsAbortController: AbortController | null = null;
  private currentClientUtterance: SpeechSynthesisUtterance | null = null;
  private clientUtteranceOnEnd: ((event: SpeechSynthesisEvent) => void) | null = null;
  private clientUtteranceOnError: ((event: SpeechSynthesisErrorEvent) => void) | null = null;
  private speech: EnhancedSpeechControls | null = null;
  private bargeInMonitoring: boolean = false;
  private bargeInInterval: NodeJS.Timeout | null = null;
  private bargeInTimer: NodeJS.Timeout | null = null;
  private ttsPlaying: boolean = false;
  private bargeInTriggered: boolean = false; // Track if barge-in has been triggered for current TTS
  private ttsCanceledByBarge: boolean = false; // Track if TTS was canceled by barge-in
  private _ttsCanceledExternally: boolean = false; // Track if TTS was canceled externally (e.g., interruptTTS)
  private healthInterval: NodeJS.Timeout | null = null;
  private restartDebounceTimer: NodeJS.Timeout | null = null;
  private _isInitialized: boolean = false;
  private isCleaningUp: boolean = false;
  private config: UnifiedAudioPipelineConfig;
  private currentTurnId: string | null = null; // Track current TTS turn
  private bargeEnabled: boolean = false;
  
  // Barge-in state
  private aiReady: boolean = false;
  private ttsStartTime: number = 0;
  private bargeInStableCount: number = 0;
  private lastBargeInCheck: number = 0;
  private lastRmsLogTime: number = 0;
  private lastLoggedRms: number = 0;
  
  // Barge-in debouncing state
  private bargeArmedAt: number | null = null;
  private lastBargeAt: number = 0;
  
  // Constants
  private readonly MIC_THRESHOLD = 0.1;
  private readonly BARGE_IN_STABILITY_MS = 80;
  private readonly GRACE_WINDOW_MS = 350;
  private readonly BARGE_IN_CHECK_INTERVAL = 20; // ~50fps
  
  // Barge-in debouncing constants
  private readonly MIC_DB_THRESH = 0.10;
  private readonly SUSTAIN_MS = 200;
  private readonly REFRACTORY_MS = 700;
  private readonly ON_BARGE_IN_DEBOUNCE_MS = 300;
  // Arm grace time and gating thresholds (dB domain where noted)
  private bargeInArmAllowedAt: number = 0;
  private readonly MIC_MIN_DB = -50; // mic must be above this
  private readonly RATIO_MIN_DB = 8; // mic - ai >= 8 dB
  // Delta-based gating constants
  private readonly MIC_MIN = 0.12;
  private readonly AI_MAX = 0.08;
  private readonly DELTA_MIN = 0.08;

  // Debounce timestamp for external onBargeIn callback
  private lastOnBargeInAt: number = 0;

  // Queue finals during TTS/quiet gate and flush at TTS end
  private pendingFinals: Array<{ text: string; confidence: number; when: number }> = [];

  // Helpers
  private isMeta(text?: string): boolean {
    if (!text) return true;
    const t = text.trim().toLowerCase();
    if (!t) return true;
    const fillers = ['hey','hi','wait','hold on','hold','ok','okay','uh','um'];
    return fillers.includes(t) || (t.split(/\s+/).length === 1 && fillers.includes(t));
  }

  private triggerLegacyBargeIn(reason: string = 'barge-in'): void {
    try { cancelDispatcherPending(reason); } catch {}
    try { this.interruptTTS(reason); } catch {}
    this.bargeInTriggered = true;
    this.bargeEnabled = false;
    try { (this as any).stopLegacyBargeMonitor?.(); } catch {}
    try { info('LEGACY', '[Session] Barge-in triggered (via ASR)'); } catch {}
  }

  private emitFinal(text: string, confidence: number, via: 'tts_end' | 'tts_barge' | 'direct' = 'direct'): void {
    try { this.config.onFinalResult?.(text, confidence); } catch {}
    try { info('SPEECH', `[SPEECH] Final: "${text}" (via=${via})`); } catch {}
  }

  constructor(config: UnifiedAudioPipelineConfig) {
    this.config = config;
  }

  // Export two functions as specified
  async ensureMicTrack(): Promise<MediaStreamTrack | null> {
    if (this._micTrack) {
      return this._micTrack;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: false
        }
      });
      
      const track = stream.getAudioTracks()[0];
      if (!track) {
        throw new Error('No audio track found in stream');
      }

      // Store the stream for analyzer creation
      this.micStream = stream;
      
      // Always ensure mic analyzer is created, even if AudioContext didn't exist yet
      this.ensureMicAnalyzer();
      
      this._micTrack = track;
      
      // Log device info
      const settings = track.getSettings();
      info('AUDIO', 'Microphone track ready', { 
        deviceId: settings.deviceId, 
        label: settings.label,
        sampleRate: settings.sampleRate 
      });
      
      // Log mic stream status
      info('AUDIO', 'Mic stream is live:', { 
        active: track.readyState === 'live',
        enabled: track.enabled,
        muted: track.muted
      });
      
      // Notify mic track is ready if we have one
      if (this.config.onMicTrackReady && this._micTrack) {
        this.config.onMicTrackReady(this._micTrack);
      }

      return track;
    } catch (err) {
      error('AUDIO', 'Failed to get microphone track:', err);
      this.config.onError?.(err as Error);
      throw err;
    }
  }

  // Ensure mic analyzer is created and wired
  private ensureMicAnalyzer(): void {
    if (this.micAnalyzer) return; // Already exists
    
    if (!this.audioContext) {
      // Create AudioContext if it doesn't exist
      this.audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)({ 
        sampleRate: 24000 
      });
      info('AUDIO', 'AudioContext created during mic analyzer setup');
    }
    
    if (this.micStream && this.audioContext) {
      this.micSource = this.audioContext.createMediaStreamSource(this.micStream);
      this.micAnalyzer = this.audioContext.createAnalyser();
      this.micAnalyzer.fftSize = 2048;
      this.micAnalyzer.smoothingTimeConstant = 0.8;
      this.micSource.connect(this.micAnalyzer);
      info('AUDIO', 'Microphone analyzer created and wired');
    }
  }

  getMicTrack(): MediaStreamTrack | null {
    return this._micTrack;
  }

  // Add synchronous method to check if mic is ready
  isMicReady(): boolean {
    return !!(this._micTrack && this.micAnalyzer);
  }

  // Helper method for components to get or create the shared AudioContext
  getOrCreateAudioContext(): AudioContext {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)({ 
        sampleRate: 24000 
      });
      info('AUDIO', 'AudioContext created via getOrCreateAudioContext');
    }
    return this.audioContext;
  }

  async initialize(): Promise<void> {
    if (this._isInitialized) {
      return;
    }

    try {
      // Create AudioContext if needed
      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)({ 
          sampleRate: 24000 
        });
        info('AUDIO', 'AudioContext created');
      }

      // Always resume AudioContext to handle suspended state
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
        info('AUDIO', 'AudioContext resumed from suspended state');
      }

      // Create TTS element if needed
      if (!this.ttsEl) {
        this.ttsEl = document.createElement('audio');
        this.ttsEl.preload = 'auto';
        this.ttsEl.volume = 1.0;
        // Try to route TTS to a preferred sink if available
        try {
          const sinkId = (typeof window !== 'undefined' && (window as any)?.localStorage?.getItem('ttsSinkId')) || (process as any)?.env?.NEXT_PUBLIC_TTS_SINK_ID;
          if (sinkId && 'setSinkId' in (this.ttsEl as any)) {
            await (this.ttsEl as any).setSinkId(sinkId);
            info('AUDIO', `TTS sink set via setSinkId`, { sinkId });
          }
        } catch {}
        info('AUDIO', 'TTS element created');
      }

      // Re-check and wire mic analyzer if missing
      if (this.micStream && !this.micAnalyzer) {
        this.ensureMicAnalyzer();
      }

      // Initialize speech recognition
      if (!this.speech) {
        this.speech = createEnhancedSpeech({
          onStart: () => this.config.onSpeechStart?.(),
          onEnd: () => this.config.onSpeechEnd?.(),
          onResult: (text, confidence) => this.config.onSpeechResult?.(text, confidence),
          // Wire BOTH onFinal (speech API) and onFinalResult (legacy naming) to the same handler
          onFinal: (text: string) => {
            const confidence = 0.9;
            try {
              const hs = this.speech?.getHealthStatus();
              const inQuiet = !!hs?.quiet_gate;
              const ttsActive = !!this.isTTSActive();
              const t = (text || '').trim();
              // One-shot instrumentation
              try {
                console.info('[DBG] final seen', {
                  ttsPlaying: ttsActive,
                  bargeEnabled: this.bargeEnabled,
                  path: BARGE_PATH,
                  onAsr: BARGE_ON_ASR,
                  text: t,
                });
              } catch {}
              if (ttsActive && this.bargeEnabled && BARGE_PATH === 'legacy' && !this.isMeta(t)) {
                // Immediate legacy barge on confident non-meta final
                try { console.info('[DBG] BARGE via ASR', { reason: 'barge-in', text: t }); } catch {}
                this.triggerLegacyBargeIn('barge-in');
                this.emitFinal(t, confidence ?? 0, 'tts_barge');
                // Safety timeout to enforce barge if TTS still active shortly after
                try { setTimeout(() => { if (this.isTTSActive()) this.triggerLegacyBargeIn('barge-timeout'); }, 50); } catch {}
                return;
              }
              if (ttsActive && !this.isMeta(t)) {
                this.pendingFinals.push({ text: t, confidence: confidence ?? 0, when: Date.now() });
                try { console.info('[DBG] QUEUE during TTS', { text: t }); } catch {}
                info('SPEECH', '[SPEECH] Queued final during TTS', { text: t });
                return;
              }
            } catch {}
            this.config.onFinalResult?.(text, confidence);
          },
          onFinalResult: (text, confidence) => {
            try {
              const hs = this.speech?.getHealthStatus();
              const inQuiet = !!hs?.quiet_gate;
              const ttsActive = !!this.isTTSActive();
              const t = (text || '').trim();
              // One-shot instrumentation
              try {
                console.info('[DBG] final seen', {
                  ttsPlaying: ttsActive,
                  bargeEnabled: this.bargeEnabled,
                  path: BARGE_PATH,
                  onAsr: BARGE_ON_ASR,
                  text: t,
                });
              } catch {}
              if (ttsActive && this.bargeEnabled && BARGE_PATH === 'legacy' && !this.isMeta(t)) {
                // Immediate legacy barge on confident non-meta final
                try { console.info('[DBG] BARGE via ASR', { reason: 'barge-in', text: t }); } catch {}
                this.triggerLegacyBargeIn('barge-in');
                this.emitFinal(t, confidence ?? 0, 'tts_barge');
                // Safety timeout to enforce barge if TTS still active shortly after
                try { setTimeout(() => { if (this.isTTSActive()) this.triggerLegacyBargeIn('barge-timeout'); }, 50); } catch {}
                return;
              }
              if (ttsActive && !this.isMeta(t)) {
                this.pendingFinals.push({ text: t, confidence: confidence ?? 0, when: Date.now() });
                try { console.info('[DBG] QUEUE during TTS', { text: t }); } catch {}
                info('SPEECH', '[SPEECH] Queued final during TTS', { text: t });
                return;
              }
            } catch {}
            this.config.onFinalResult?.(text, confidence);
          },
          onError: (error) => this.config.onSpeechError?.(error),
          onBargeIn: () => this.emitBargeIn(),
          onQuietGateStart: () => this.config.onQuietGateStart?.(),
          onQuietGateEnd: () => this.config.onQuietGateEnd?.(),
          onQuietGateCancel: () => this.config.onQuietGateCancel?.(),
          onHealth: (health) => this.config.onHealth?.(health)
        });
        info('AUDIO', 'Speech recognition initialized');
      }

      this._isInitialized = true;
      info('AUDIO', 'Pipeline initialized successfully');

      // Notify mic track is ready if we have one
      if (this.config.onMicTrackReady && this._micTrack) {
        this.config.onMicTrackReady(this._micTrack);
      }

    } catch (err) {
      error('AUDIO', 'Failed to initialize pipeline:', err);
      throw err;
    }
  }

  async playTTS(text: string, turnId: string): Promise<void> {
    if (this.isCleaningUp) {
      warn('AUDIO', 'Cannot play TTS during cleanup');
      return;
    }

    // Guard: ensure initialized first
    await this.initialize();

    // Reset external cancel flag and stop any existing TTS
    this._ttsCanceledExternally = false;
    this.stopTTS();

    // Set new abort controller
    this.ttsAbortController = new AbortController();
    
    info('TTS', `TTS start ${Date.now()}`);
    this.config.onTTSStart?.(turnId);
    this.currentTurnId = turnId; // Update current turn ID

    // Record TTS start time for grace window
    this.ttsStartTime = Date.now();
    
    // Reset barge-in state for new TTS playback
    this.bargeInTriggered = false;
    // Flip unified TTS flag
    this.ttsPlaying = true;

    // Gate ASR during TTS and set mute state
    this.speech?.setTTSPlaying(true);
    setDispatcherTtsPlaying(true);
    setMuted(true);

    // Start AI analyzer at TTS start
    this.startBargeInMonitoring();
    // Attach aiAnalyser for v2 energy path
    if (BARGE_PATH === 'v2' && this.audioContext && this.ttsEl) {
      try {
        this.aiAnalyser = this.aiAnalyser || this.audioContext.createAnalyser();
        this.aiAnalyser.fftSize = 2048;
        const ttsSource = this.audioContext.createMediaElementSource(this.ttsEl);
        const ttsTap = this.audioContext.createGain();
        ttsSource.connect(ttsTap);
        ttsTap.connect(this.aiAnalyser);
        ttsTap.connect(this.audioContext.destination);
        info('AUDIO', 'aiAnalyser: attached');
      } catch { info('AUDIO', 'aiAnalyser: missing'); }
    }
    // Flip barge flags according to selected path
    if (BARGE_PATH === 'v2') {
      bargeEnabled = true; ttsStartAt = performance.now(); bargeInArmAllowedAt = ttsStartAt + ARM_MS; micBurstSince = null; decisionSince = null;
      info('AUDIO', 'BARGE PATH: v2 (armed)');
    } else {
      this.bargeInArmAllowedAt = Date.now() + 300; micBurstSince = null; decisionSince = null;
      this.speech?.setTTSPlaying(true); // legacy path uses speech mute gating already
      this.bargeInTriggered = false;
      this.bargeEnabled = true;
      // start legacy monitor if present
      try { (this as any).startLegacyBargeMonitor?.(); } catch {}
      info('AUDIO', 'BARGE PATH: legacy (armed)');
    }
    try { notifyTTSStart(); } catch {}

    try {
      // Check TTS mode - if client mode, skip server TTS entirely
      if (process.env.NEXT_PUBLIC_TTS_MODE === 'client') {
        info('AUDIO', 'TTS mode is client - using client TTS directly');
        await this.playClientTTS(text, turnId);
      } else {
        // Try server TTS first
        await this.playServerTTS(text, turnId);
      }
      
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        info('AUDIO', 'TTS aborted');
        return;
      }
      
      // Only try fallback if we weren't already in client mode
      if (process.env.NEXT_PUBLIC_TTS_MODE !== 'client') {
        warn('AUDIO', 'Server TTS failed, trying fallback:', err);
        
        // Fallback to client TTS
        try {
          await this.playClientTTS(text, turnId);
        } catch (fallbackError) {
          // Don't beep for "interrupted" errors (expected barge-in behavior)
          if (fallbackError instanceof Error && fallbackError.message.includes('interrupted')) {
            info('AUDIO', 'Client TTS interrupted by barge-in (expected)');
            return;
          }
          
          warn('AUDIO', 'Client TTS failed, using beep fallback:', fallbackError);
          
          // Last resort: play a beep to maintain flow
          await this.playBeepFallback(turnId);
        }
      } else {
        // If we were already in client mode and it failed, use beep fallback
        // Don't beep for "interrupted" errors (expected barge-in behavior)
        if (err instanceof Error && err.message.includes('interrupted')) {
          info('AUDIO', 'Client TTS interrupted by barge-in (expected)');
          return;
        }
        
        warn('AUDIO', 'Client TTS failed, using beep fallback:', err);
        await this.playBeepFallback(turnId);
      }
    } finally {
      // Always ensure proper cleanup on completion/abort/error
      this.stopBargeInMonitoring();
      try { this.aiSource?.disconnect(); this.aiAnalyser?.disconnect(); } catch {}
      this.aiSource = null; this.aiAnalyser = null;
      this.speech?.setTTSPlaying(false);
      setDispatcherTtsPlaying(false);
      try { notifyTTSEndOrBargeIn(); } catch {}
      setMuted(false);
      if (!this.bargeInTriggered) this.speech?.startQuietGate();
      this.config.onTTSEnd?.(turnId);
      // Clear unified TTS flag
      this.ttsPlaying = false;
      // Reset barge flags
      bargeEnabled = false; micBurstSince = null; decisionSince = null;
      // Stop legacy monitor if present
      try { (this as any).stopLegacyBargeMonitor?.(); } catch {}
      // Flush queued finals after TTS ends
      while (this.pendingFinals.length) {
        const evt = this.pendingFinals.shift()!;
        if (!this.bargeInTriggered) {
          try {
            this.config.onFinalResult?.(evt.text, evt.confidence);
            info('SPEECH', `[SPEECH] Final: "${evt.text}" (via=tts_end)`);
          } catch {}
        }
      }
      // Flush queued finals after TTS ends
      while (this.pendingFinals.length) {
        const evt = this.pendingFinals.shift()!;
        try {
          this.config.onFinalResult?.(evt.text, evt.confidence);
        } catch {}
      }
      
      info('AUDIO', 'TTS finished');
      
      // Debounced restart of speech recognition after TTS finishes
      this.debouncedRestartSpeechRecognition();
    }
  }

  private async playServerTTS(text: string, turnId: string): Promise<void> {
    const res = await fetch(`/api/tts?text=${encodeURIComponent(text)}`, { 
      signal: this.ttsAbortController!.signal 
    });
    
    if (!res.ok || res.status === 204) {
      throw new Error(`Server TTS failed: ${res.status} ${res.statusText}`);
    }
    
    const data = await res.arrayBuffer();
    if (data.byteLength === 0) {
      throw new Error('Server TTS returned empty audio data');
    }
    
    const mime = res.headers.get("content-type") || "audio/mpeg";
    const blob = new Blob([data], { type: mime });
    const objectUrl = URL.createObjectURL(blob);

    // Ensure AI analyzer is created and wired
    if (this.audioContext && this.ttsEl) {
      if (this.aiSource) {
        try { this.aiSource.disconnect(); } catch {}
      }
      this.aiSource = this.audioContext.createMediaElementSource(this.ttsEl);
      this.aiAnalyser = this.audioContext.createAnalyser();
      this.aiAnalyser.fftSize = 2048; // As specified in requirements
      this.aiSource.connect(this.aiAnalyser);
      this.aiSource.connect(this.audioContext.destination);
      info('AUDIO', 'AI_ANALYZER_READY:true');
    }

    // Assign and play, then wait for completion or error
    this.ttsEl!.src = objectUrl;

    await new Promise<void>((resolve, reject) => {
      const handleEnded = () => {
        cleanup();
        if (this._ttsCanceledExternally) {
          resolve();
          return;
        }
        info('TTS', 'Server playback finished', { turnId });
        resolve();
      };
      const handleError = (ev: Event) => {
        cleanup();
        if (this._ttsCanceledExternally) {
          resolve();
          return;
        }
        reject(new Error('Server TTS playback error'));
      };
      const cleanup = () => {
        if (this.ttsEl && this.ttsAudioEndedHandler) {
          this.ttsEl.removeEventListener('ended', this.ttsAudioEndedHandler);
          this.ttsAudioEndedHandler = null;
        }
        if (this.ttsEl && this.ttsAudioErrorHandler) {
          this.ttsEl.removeEventListener('error', this.ttsAudioErrorHandler);
          this.ttsAudioErrorHandler = null;
        }
        if (this.ttsEl && this.ttsEl.src && this.ttsEl.src.startsWith('blob:')) {
          try { URL.revokeObjectURL(this.ttsEl.src); } catch {}
        }
      };

      this.ttsAudioEndedHandler = handleEnded;
      this.ttsAudioErrorHandler = handleError;
      this.ttsEl!.addEventListener('ended', this.ttsAudioEndedHandler, { once: true });
      this.ttsEl!.addEventListener('error', this.ttsAudioErrorHandler, { once: true });

      this.ttsEl!.play()
        .then(() => {
          info('TTS', 'Server playback started', { turnId });
        })
        .catch((err) => {
          cleanup();
          if (this._ttsCanceledExternally) {
            resolve();
            return;
          }
          reject(err);
        });
    });
  }

  private async playClientTTS(text: string, turnId: string): Promise<void> {
    if (!('speechSynthesis' in window)) {
      throw new Error('SpeechSynthesis not available');
    }

    // Clear any stale audio before creating new utterance
    if (window.speechSynthesis.speaking) {
      window.speechSynthesis.cancel();
    }

    return new Promise<void>((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.9;
      utterance.pitch = 1.0;
      utterance.volume = 0.8;

      // Store the utterance reference
      this.currentClientUtterance = utterance;

      utterance.onstart = () => {
        info('TTS', 'Client playback started', { turnId });
        
        // Set up aiSource and aiAnalyser if missing for barge-in functionality
        if (this.audioContext && !this.aiSource) {
          // Create a dummy audio element to connect to AudioContext
          const dummyAudio = new Audio();
          dummyAudio.src = 'data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBSuBzvLZiTYIG2m98OScTgwOUarm7blmGgU7k9n1unEiBC13yO/eizEIHWq+8+OWT';
          dummyAudio.loop = true;
          dummyAudio.volume = 0;
          
          try {
            this.aiSource = this.audioContext.createMediaElementSource(dummyAudio);
            this.aiAnalyser = this.audioContext.createAnalyser();
            this.aiAnalyser.fftSize = 2048;
            this.aiSource.connect(this.aiAnalyser);
            this.aiSource.connect(this.audioContext.destination);
            
            info('AUDIO', 'Client TTS wired to AudioContext for barge-in monitoring');
          } catch (err) {
            warn('AUDIO', 'Failed to wire client TTS to AudioContext:', err);
          }
        }
      };

      this.clientUtteranceOnEnd = () => {
        // Remove listeners
        if (this.currentClientUtterance && this.clientUtteranceOnEnd) {
          this.currentClientUtterance.onend = null as any;
        }
        if (this.currentClientUtterance && this.clientUtteranceOnError) {
          this.currentClientUtterance.onerror = null as any;
        }
        this.clientUtteranceOnEnd = null;
        this.clientUtteranceOnError = null;

        this.currentClientUtterance = null;
        this.ttsCanceledByBarge = false;
        if (this._ttsCanceledExternally) {
          resolve();
          return;
        }
        info('TTS', 'Client playback finished', { turnId });
        resolve();
      };

      this.clientUtteranceOnError = (event: SpeechSynthesisErrorEvent) => {
        // Remove listeners
        if (this.currentClientUtterance && this.clientUtteranceOnEnd) {
          this.currentClientUtterance.onend = null as any;
        }
        if (this.currentClientUtterance && this.clientUtteranceOnError) {
          this.currentClientUtterance.onerror = null as any;
        }
        const localUtterance = this.currentClientUtterance;
        this.clientUtteranceOnEnd = null;
        this.clientUtteranceOnError = null;
        this.currentClientUtterance = null;
        
        // Handle "interrupted" error from barge-in as expected behavior
        if (event.error === 'interrupted' && (this.ttsCanceledByBarge || this._ttsCanceledExternally)) {
          debug('TTS', 'Client TTS interrupted by barge-in (expected)', { turnId });
          this.ttsCanceledByBarge = false;
          resolve(); // Resolve instead of reject for expected interruption
          return;
        }
        
        // If externally canceled, resolve quietly without warnings
        if (this._ttsCanceledExternally) {
          resolve();
          return;
        }
        
        error('TTS', 'Client playback error:', (event as any)?.error);
        reject(new Error(`Client TTS error: ${(event as any)?.error || 'unknown'}`));
      };

      utterance.onend = this.clientUtteranceOnEnd as any;
      utterance.onerror = this.clientUtteranceOnError as any;

      speechSynthesis.speak(utterance);
    });
  }

  private async playBeepFallback(turnId: string): Promise<void> {
    if (!this.audioContext) {
      throw new Error('AudioContext not available for beep fallback');
    }

    // Create a short beep using oscillator
    const oscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(this.audioContext.destination);
    
    oscillator.frequency.setValueAtTime(800, this.audioContext.currentTime);
    oscillator.type = 'sine';
    
    gainNode.gain.setValueAtTime(0, this.audioContext.currentTime);
    gainNode.gain.linearRampToValueAtTime(0.1, this.audioContext.currentTime + 0.01);
    gainNode.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + 0.2);
    
    oscillator.start(this.audioContext.currentTime);
    oscillator.stop(this.audioContext.currentTime + 0.2);
    
    info('TTS', 'Beep fallback played', { turnId });
    
    // Wait for the beep to finish
    return new Promise<void>((resolve) => {
      setTimeout(resolve, 250);
    });
  }



  private cancelClientTTS(): void {
    try { 
      window.speechSynthesis?.cancel(); 
    } catch {}
    // Remove bound handlers to prevent double-firing in future turns
    if (this.currentClientUtterance) {
      try { (this.currentClientUtterance as any).onend = null; } catch {}
      try { (this.currentClientUtterance as any).onerror = null; } catch {}
    }
    this.clientUtteranceOnEnd = null;
    this.clientUtteranceOnError = null;
    this.currentClientUtterance = null;
  }

  // Alias to satisfy callers expecting stopClientTTS; delegates to cancelClientTTS
  private stopClientTTS(reason: string = 'stop'): void {
    try { if (reason === 'barge-in') this.ttsCanceledByBarge = true; } catch {}
    this.cancelClientTTS();
    try { info('TTS', 'Client TTS stopped', { reason }); } catch {}
  }

  stopTTS(): void {
    try {
      if (process.env.NEXT_PUBLIC_TTS_MODE === 'client') {
        this.stopClientTTS('stop');
        return;
      }

      if (!this.ttsEl) return;

      // Abort any ongoing TTS request
      if (this.ttsAbortController) {
        try { this.ttsAbortController.abort(); } catch {}
        this.ttsAbortController = null;
      }

      // Stop audio playback
      try { this.ttsEl.pause(); } catch {}
      try { this.ttsEl.currentTime = 0; } catch {}
      info('AUDIO', 'TTS stopped');
      this.ttsPlaying = false;
    } catch (e) {
      error('AUDIO', 'Error stopping TTS:', e);
    }
  }

  // Hard stop for TTS - forcibly interrupt regardless of state
  interruptTTS(reason: string = 'barge-in'): void {
    // Quick guard to avoid double work if nothing is currently active
    if (!this.isTTSActive() && !this.ttsEl?.src) {
      this._ttsCanceledExternally = true;
      this.speech?.setTTSPlaying(false);
      setMuted(false);
      return;
    }
    // Mark as externally canceled so handlers resolve quietly
    this._ttsCanceledExternally = true;
    // Stop barge-in monitoring early to avoid reentrancy loops
    this.stopBargeInMonitoring();
    // Cut quiet gate immediately on barge-in
    this.clearQuietGate();
    // Handle Web Speech cancellation
    try {
      window.speechSynthesis?.cancel();
    } catch (err) {
      // Ignore errors during forced cancellation
    }
    
    // Handle HTMLAudioElement interruption
    if (this.ttsEl) {
      try {
        this.ttsEl.pause();
        this.ttsEl.currentTime = 0;
        this.ttsEl.src = ''; // Break decode and clear source
        // Remove audio element listeners if present
        if (this.ttsAudioEndedHandler) {
          try { this.ttsEl.removeEventListener('ended', this.ttsAudioEndedHandler); } catch {}
          this.ttsAudioEndedHandler = null;
        }
        if (this.ttsAudioErrorHandler) {
          try { this.ttsEl.removeEventListener('error', this.ttsAudioErrorHandler); } catch {}
          this.ttsAudioErrorHandler = null;
        }
        // Remove event listeners by cloning the element
        const newEl = this.ttsEl.cloneNode(false) as HTMLAudioElement;
        this.ttsEl.parentNode?.replaceChild(newEl, this.ttsEl);
        this.ttsEl = newEl;
      } catch (err) {
        // Ignore errors during forced interruption
      }
    }
    
    // Clear internal flags and state
    this.currentClientUtterance = null;
    this.ttsCanceledByBarge = false;
    this.bargeInTriggered = false;
    this.currentTurnId = null;
    
    // Clear timers
    if (this.restartDebounceTimer) {
      clearTimeout(this.restartDebounceTimer);
      this.restartDebounceTimer = null;
    }
    
    // Clear TTS playing state and mute
    this.speech?.setTTSPlaying(false);
    setDispatcherTtsPlaying(false);
    try { queueMicrotask(() => emitHeld('tts_end')); } catch {}
    setMuted(false);
    
    // Clear abort controller
    if (this.ttsAbortController) {
      try {
        this.ttsAbortController.abort();
      } catch {}
      this.ttsAbortController = null;
    }
    
    try {
      this.ttsCanceledByBarge = true;
      info('AUDIO', `TTS forcibly interrupted (reason: ${reason})`);
      // Stop current TTS playback immediately
      if (process.env.NEXT_PUBLIC_TTS_MODE === 'client') {
        this.stopClientTTS(reason);
      } else {
        this.stopTTS();
      }
    } finally {
      this.ttsPlaying = false;
      this.speech?.setTTSPlaying(false);
      setDispatcherTtsPlaying(false);
      try { notifyTTSEndOrBargeIn(); } catch {}
      setMuted(false);
    }
  }

  private startBargeInMonitoring(): void {
    if (this.bargeInMonitoring) return;

    // Check if mic is ready before starting barge-in monitoring
    if (!this.isMicReady()) {
      info('AUDIO', 'Mic not ready, skipping barge-in monitoring');
      return;
    }

    // Client TTS is supported with AI analyser when attached
    if (process.env.NEXT_PUBLIC_TTS_MODE === 'client') {
      this.bargeInMonitoring = true;
      info('AUDIO', 'BARGE_MONITORING_START mic:true ai:true (client TTS)');
      this.bargeInInterval = setInterval(() => {
        this.checkBargeIn();
      }, this.BARGE_IN_CHECK_INTERVAL);
      return;
    }

    // Check if we have an AI analyzer for barge-in detection
    if (!this.aiAnalyser) {
      // Try to wire the AI analyzer if it's missing
      if (this.audioContext && this.ttsEl && !this.aiSource) {
        try {
          this.aiSource = this.audioContext.createMediaElementSource(this.ttsEl);
          this.aiAnalyser = this.audioContext.createAnalyser();
          this.aiAnalyser.fftSize = 2048; // As specified in requirements
          this.aiSource.connect(this.aiAnalyser);
          // Also route to output so audio is actually heard:
          this.aiSource.connect(this.audioContext.destination);
          info('AUDIO', 'AI_ANALYZER_READY:true (wired during barge-in start)');
        } catch (err) {
          error('AUDIO', 'Failed to wire AI analyzer during barge-in start:', err);
        }
      }
      
      if (!this.aiAnalyser) {
        // Check if we're in client TTS mode without analyser
        if (process.env.NEXT_PUBLIC_TTS_MODE === 'client') {
          info('AUDIO', 'Skipping barge-in monitoring in client TTS mode');
          return;
        }
        info('AUDIO', 'AI analyzer not ready, skipping barge-in monitoring');
        return;
      }
    }

    this.bargeInMonitoring = true;
    info('AUDIO', 'BARGE_MONITORING_START mic:true ai:true');
    debug('AUDIO', 'Starting barge-in monitoring');

    this.bargeInInterval = setInterval(() => {
      this.checkBargeIn();
    }, this.BARGE_IN_CHECK_INTERVAL);
  }

  private stopBargeInMonitoring(): void {
    if (this.bargeInInterval) {
      clearInterval(this.bargeInInterval);
      this.bargeInInterval = null;
    }

    if (this.bargeInTimer) {
      clearTimeout(this.bargeInTimer);
      this.bargeInTimer = null;
    }

    this.bargeInMonitoring = false;
    this.bargeInStableCount = 0;
    this.bargeInTriggered = false; // Reset triggered flag
    this.bargeArmedAt = null; // Reset barge arming state
    debug('AUDIO', 'Stopped barge-in monitoring');
  }

  // Immediately cancel any active quiet gate to allow ASR to resume
  private clearQuietGate(): void {
    try {
      this.speech?.cancelQuietGate();
    } catch {}
  }

  private checkBargeIn(): void {
    if (BARGE_PATH !== 'v2') return; // hard-gate v2
    if (!this.micAnalyzer) return;

    const now = Date.now();
    const armed = typeof performance !== 'undefined' ? (performance.now() >= bargeInArmAllowedAt) : (now - this.ttsStartTime >= ARM_MS);
    if (!bargeEnabled || !this.isTTSActive()) { return; }

    const micDb = getRmsDb(this.micAnalyzer);
    const aiDb  = getRmsDb(this.aiAnalyser || undefined);
    const delta = micDb - aiDb;
    if (micDb >= MIN_DB) { if (!micBurstSince) micBurstSince = performance.now(); } else { micBurstSince = null; }
    const burstMs = micBurstSince ? (performance.now() - micBurstSince) : 0;

    // Get auxiliary speech state
    const speechHealth = this.speech?.getHealthStatus();
    const vadSpeaking = speechHealth?.vad_speaking || false;
    const currentSpeechMs = speechHealth?.vad_speaking ? (speechHealth.vad_speech_duration || 0) : 0;
    const vadOK = vadSpeaking && currentSpeechMs >= VAD_MS;
    const energyOK = (micDb >= MIN_DB) && (burstMs >= BURST_MS) && (!Number.isFinite(aiDb) || delta >= DELTA_DB);
    const decision = armed && (vadOK || energyOK);

    if (BARGE_PATH === 'v2') debug('BARGE-IN', 'v2 candidate', {
      vadSpeaking,
      currentSpeechMs,
      micDb: Number.isFinite(micDb) ? Number(micDb.toFixed(1)) : null,
      aiDb: Number.isFinite(aiDb) ? Number(aiDb.toFixed(1)) : null,
      delta: Number.isFinite(aiDb) ? Number(delta.toFixed(1)) : null,
      burstMs: Math.round(burstMs),
      armed,
      decision
    });

    // legacy VAD short-circuit moved to legacy-only path elsewhere

    if (decision) {
      if (!decisionSince) decisionSince = performance.now();
      if (performance.now() - (decisionSince || 0) >= SUSTAIN_MS) {
        decisionSince = null; bargeEnabled = false;
        try { cancelDispatcherPending('barge-in'); } catch {}
        this.interruptTTS('barge-in');
        setTimeout(() => { this.speech?.startRecognitionLoop(); }, 100);
        this.emitBargeIn();
      }
    } else {
      decisionSince = null;
    }
  }


  // RMS helper function as specified in requirements
  private rms(analyser: AnalyserNode): number {
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);
    
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i] * dataArray[i];
    }
    
    return Math.sqrt(sum / dataArray.length) / 255;
  }

  // Debounced emitter for external onBargeIn callback
  private emitBargeIn(): void {
    const now = Date.now();
    if (now - this.lastOnBargeInAt < this.ON_BARGE_IN_DEBOUNCE_MS) {
      return;
    }
    this.lastOnBargeInAt = now;
    this.config.onBargeIn?.();
  }

  // Unified TTS state
  private isTTSActive(): boolean {
    return !!this.ttsPlaying;
  }

  // Public method to get current mic RMS for debug overlay
  getMicRMS(): number {
    if (!this.micAnalyzer) return 0;
    const rms = this.rms(this.micAnalyzer);
    
    // Only log RMS when it changes significantly (0.05 threshold) or crosses 0
    const now = Date.now();
    const rmsChanged = Math.abs(rms - this.lastLoggedRms) > 0.05;
    const crossedZero = (this.lastLoggedRms === 0 && rms > 0) || (this.lastLoggedRms > 0 && rms === 0);
    
    if ((rmsChanged || crossedZero) && (!this.lastRmsLogTime || now - this.lastRmsLogTime > 500)) {
      debug('AUDIO', `Mic RMS: ${rms.toFixed(3)} (change: ${(rms - this.lastLoggedRms).toFixed(3)})`);
      this.lastRmsLogTime = now;
      this.lastLoggedRms = rms;
    }
    
    return rms;
  }

  private startHealthMonitoring(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
    }

    this.healthInterval = setInterval(() => {
      const health = {
        audioContext: this.audioContext?.state || 'null',
        micStream: !!this.micStream,
        micTrack: !!this._micTrack,
        ttsPlaying: !!this.ttsEl?.src && !this.ttsEl?.paused,
        bargeInMonitoring: this.bargeInMonitoring
      };
      debug('HEALTH', 'Health check', health);
    }, 5000);
  }

  // === CLEANUP ===

  cleanup(): void {
    if (this.isCleaningUp) {
      debug('AUDIO', 'Cleanup already in progress');
      return;
    }

    this.isCleaningUp = true;
    info('AUDIO', 'DISCONNECT_REASON:cleanup_requested');
    info('AUDIO', 'Cleaning up pipeline');

    // Stop health monitoring
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }

    // Clear restart debounce timer
    if (this.restartDebounceTimer) {
      clearTimeout(this.restartDebounceTimer);
      this.restartDebounceTimer = null;
    }

    // Don't throw if there's no controller
    try { 
      this.stopTTS(); 
    } catch {}

    // Stop speech recognition
    if (this.speech) {
      this.speech.pauseRecognitionLoop();
      this.speech = null;
    }

    // Stop microphone
    if (this.micStream) {
      this.micStream.getTracks().forEach(track => track.stop());
      this.micStream = null;
    }

    // Clean up audio element
    if (this.ttsEl) {
      this.ttsEl.remove();
      this.ttsEl = null;
    }

    // Don't close the AudioContext unless you're really tearing down the session
    // Disconnect AI nodes safely:
    try { 
      this.aiSource?.disconnect(); 
      this.aiAnalyser?.disconnect(); 
    } catch {}
    this.aiSource = null; 
    this.aiAnalyser = null;

    // Clear analyzers but keep the context
    this.micAnalyzer = null;
    this.micSource = null;
    this._micTrack = null;

    this._isInitialized = false;
    this.isCleaningUp = false;

    try { resetHeldFinalState(); } catch {}
    info('AUDIO', 'Pipeline cleanup complete');
  }

  // Force cleanup when session is truly ending (not HMR)
  forceCleanup(): void {
    info('AUDIO', 'Force cleanup - closing AudioContext');
    
    // First do normal cleanup
    this.cleanup();
    
    // Then close the AudioContext
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
      this.audioContext = null;
      info('AUDIO', 'AudioContext closed');
    }
  }

  // === PUBLIC API ===

  isTTSPlaying(): boolean {
    return this.ttsEl ? !this.ttsEl.paused && !!this.ttsEl.src : false;
  }

  getCurrentTurnId(): string | null {
    return this.currentTurnId;
  }

  getMicStream(): MediaStream | null {
    return this.micStream;
  }

  isInitialized(): boolean {
    return this._isInitialized;
  }

  // Start speech recognition
  startSpeech(): void {
    if (this.speech) {
      this.speech.startRecognitionLoop();
    }
  }

  // Stop speech recognition
  stopSpeech(): void {
    if (this.speech) {
      this.speech.pauseRecognitionLoop();
    }
  }

  // Debug information methods
  getDebugInfo() {
    return {
      micReady: this.isMicReady(),
      micRMS: this.getMicRMS(),
      ttsPlaying: this.isTTSPlaying(),
      bargeInMonitoring: this.bargeInMonitoring,
      audioContextState: this.audioContext?.state || 'null',
      speechActive: this.speech ? true : false,
      micTrackId: this._micTrack?.id || 'none',
      micAnalyzerReady: !!this.micAnalyzer,
      aiAnalyzerReady: !!this.aiAnalyser,
      currentTurnId: this.currentTurnId
    };
  }

  // Set output device for TTS playback
  async setOutputDevice(deviceId: string): Promise<void> {
    if (!this.ttsEl) {
      throw new Error('TTS element not initialized');
    }
    
    if (!('setSinkId' in this.ttsEl)) {
      throw new Error('setSinkId not supported in this browser');
    }
    
    try {
      await (this.ttsEl as any).setSinkId(deviceId);
      info('AUDIO', `Output device set to: ${deviceId}`);
    } catch (err) {
      error('AUDIO', 'Failed to set output device:', err);
      throw err;
    }
  }

  

  // Self-test method to play a short beep for audio routing verification
  async playSelfTest(): Promise<void> {
    try {
      info('AUDIO', 'Starting self-test beep...');
      
      // Ensure AudioContext is ready
      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      }
      
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
      
      // Create a short beep
      const oscillator = this.audioContext.createOscillator();
      const gainNode = this.audioContext.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(this.audioContext.destination);
      
      oscillator.frequency.setValueAtTime(440, this.audioContext.currentTime); // A4 note
      gainNode.gain.setValueAtTime(0.1, this.audioContext.currentTime);
      
      oscillator.start();
      oscillator.stop(this.audioContext.currentTime + 0.5); // 500ms beep
      
      info('AUDIO', 'Self-test beep started');
      
      // Clean up after beep
      setTimeout(() => {
        oscillator.disconnect();
        gainNode.disconnect();
        info('AUDIO', 'Self-test beep completed');
      }, 600);
      
    } catch (err) {
      error('AUDIO', 'Self-test beep failed:', err);
      throw err;
    }
  }

  private restartSpeechRecognition(): void {
    if (this.speech) {
      // Use the new guarded start method
      this.speech.startRecognitionLoop();
    }
  }

  private debouncedRestartSpeechRecognition(): void {
    // Debounce restart to prevent rapid successive calls
    if (this.restartDebounceTimer) {
      clearTimeout(this.restartDebounceTimer);
    }
    
    this.restartDebounceTimer = setTimeout(() => {
      this.restartSpeechRecognition();
    }, 100); // 100ms debounce
  }
}

// Singleton instance
let unifiedPipeline: UnifiedAudioPipeline | null = null;

// Fast Refresh/HMR protection
let isHMRCleanupInProgress = false;

export function getUnifiedAudioPipeline(config?: UnifiedAudioPipelineConfig): UnifiedAudioPipeline {
  // Fast Refresh/HMR protection - clean up previous instance if in development
  if (process.env.NODE_ENV === 'development' && unifiedPipeline && !isHMRCleanupInProgress) {
    isHMRCleanupInProgress = true;
    try {
      info('AUDIO', 'HMR detected - cleaning up previous pipeline instance');
      unifiedPipeline.forceCleanup();
    } finally {
      isHMRCleanupInProgress = false;
    }
    unifiedPipeline = null;
  }
  
  if (!unifiedPipeline) {
    unifiedPipeline = new UnifiedAudioPipeline(config || {});
  }
  return unifiedPipeline;
}

// Helper to get the current pipeline instance if it exists
export function getCurrentPipeline(): UnifiedAudioPipeline | null {
  return unifiedPipeline;
}

// Check if current pipeline was created for testing
export function isTestPipeline(): boolean {
  return unifiedPipeline?.config?.isTestPipeline === true;
}

// Get pipeline instance with test flag
export function getTestPipeline(config?: UnifiedAudioPipelineConfig): UnifiedAudioPipeline {
  const testConfig = { ...config, isTestPipeline: true };
  // Always create a new instance for testing, don't reuse singleton
  return new UnifiedAudioPipeline(testConfig);
}

export function cleanupUnifiedAudioPipeline(): void {
  if (unifiedPipeline && !unifiedPipeline.config?.isTestPipeline && !isHMRCleanupInProgress) {
    unifiedPipeline.cleanup();
    unifiedPipeline = null;
    info('AUDIO', 'Singleton pipeline cleaned up');
  }
}

// React hook for debug overlay
export function useAudioDebugOverlay() {
  const [debugInfo, setDebugInfo] = useState(() => {
    const pipeline = getCurrentPipeline();
    return pipeline ? pipeline.getDebugInfo() : null;
  });

  useEffect(() => {
    const pipeline = getCurrentPipeline();
    if (!pipeline) return;

    const interval = setInterval(() => {
      setDebugInfo(pipeline.getDebugInfo());
    }, 200); // Update every 200ms for responsive UI

    return () => clearInterval(interval);
  }, []);

  return debugInfo;
}

