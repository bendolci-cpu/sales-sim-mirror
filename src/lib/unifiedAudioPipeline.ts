// Unified Audio Pipeline - Single source of truth for all audio and speech recognition
// Consolidates: AudioManager, LegacyAudioManager, BargeInDetector, ASRManager, TTSPlayer

import { logInfo, logDebug, logWarn, logError } from './logger';
import { createEnhancedSpeech, type EnhancedSpeechControls } from './speech/enhancedSpeech';

export interface UnifiedAudioPipelineConfig {
  onBargeIn?: () => void;
  onTTSStart?: (turnId: string) => void;
  onTTSEnd?: (turnId: string) => void;
  onTTSError?: (error: Error) => void;
  onMicTrackReady?: (track: MediaStreamTrack) => void;
  onFinalResult?: (text: string, confidence?: number) => void;
  onError?: (error: Error) => void;
}

export class UnifiedAudioPipeline {
  private audioContext: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private _micTrack: MediaStreamTrack | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micAnalyzer: AnalyserNode | null = null;
  private aiSource: MediaElementAudioSourceNode | null = null;
  private aiAnalyser: AnalyserNode | null = null;
  private ttsEl: HTMLAudioElement | null = null;
  private ttsAbortController: AbortController | null = null;
  private speech: EnhancedSpeechControls | null = null;
  private bargeInMonitoring: boolean = false;
  private bargeInInterval: NodeJS.Timeout | null = null;
  private bargeInTimer: NodeJS.Timeout | null = null;
  private healthInterval: NodeJS.Timeout | null = null;
  private _isInitialized: boolean = false;
  private isCleaningUp: boolean = false;
  private config: UnifiedAudioPipelineConfig;
  
  // Barge-in state
  private aiReady: boolean = false;
  private ttsStartTime: number = 0;
  private bargeInStableCount: number = 0;
  private lastBargeInCheck: number = 0;
  
  // Constants
  private readonly MIC_THRESHOLD = 0.1;
  private readonly BARGE_IN_STABILITY_MS = 80;
  private readonly GRACE_WINDOW_MS = 350;
  private readonly BARGE_IN_CHECK_INTERVAL = 20; // ~50fps

  constructor(config: UnifiedAudioPipelineConfig) {
    this.config = config;
  }

  // Export two functions as specified
  async ensureMicTrack(): Promise<MediaStreamTrack> {
    // If a cached _micTrack exists and readyState === 'live', resolve it
    if (this._micTrack && this._micTrack.readyState === 'live') {
      return this._micTrack;
    }

    // Otherwise await navigator.mediaDevices.getUserMedia with proper audio constraints
    const stream = await navigator.mediaDevices.getUserMedia({ 
      audio: { 
        echoCancellation: true, 
        noiseSuppression: true, 
        autoGainControl: false 
      } 
    });
    const track = stream.getAudioTracks()[0];
    
    if (!track) {
      throw new Error('No audio track found in microphone stream');
    }

    // Store the stream for getMicStream() to return
    this.micStream = stream;

    // Create/attach the micAnalyser if not already created
    if (this.audioContext && !this.micAnalyzer) {
      this.micSource = this.audioContext.createMediaStreamSource(stream);
      this.micAnalyzer = this.audioContext.createAnalyser();
      this.micAnalyzer.fftSize = 256;
      this.micAnalyzer.smoothingTimeConstant = 0.8;
      this.micSource.connect(this.micAnalyzer);
      logInfo('[UnifiedAudio] Microphone analyzer ready');
    }

    // Store in _micTrack
    this._micTrack = track;
    
    // Add an ended listener that clears _micTrack so we can re-request if the device changes
    track.addEventListener('ended', () => {
      this._micTrack = null;
      logInfo('[UnifiedAudio] Mic track ended, cleared from cache');
    });

    // Log device information
    const deviceId = track.getSettings?.()?.deviceId;
    const label = track.label;
    logInfo('[UnifiedAudio] Mic track created', { deviceId, label });

    // Notify mic track is ready if callback provided
    if (this.config.onMicTrackReady) {
      this.config.onMicTrackReady(track);
    }

    return track;
  }

  getMicTrack(): MediaStreamTrack | null {
    return this._micTrack;
  }

  // Add synchronous method to check if mic is ready
  isMicReady(): boolean {
    return !!(this._micTrack && this.micAnalyzer);
  }

  async initialize(): Promise<void> {
    if (this._isInitialized || this.isCleaningUp) {
      return;
    }

    try {
      logInfo('[UnifiedAudio] Initializing pipeline');
      
      // Create AudioContext after user gesture (this should be called from a user action)
      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)({ 
          sampleRate: 24000 
        });
        logInfo('[UnifiedAudio] AudioContext created');
      }

      // If micStream exists but micAnalyzer is null, create it now
      if (this.micStream && !this.micAnalyzer) {
        this.micSource = this.audioContext.createMediaStreamSource(this.micStream);
        this.micAnalyzer = this.audioContext.createAnalyser();
        this.micAnalyzer.fftSize = 256;
        this.micAnalyzer.smoothingTimeConstant = 0.8;
        this.micSource.connect(this.micAnalyzer);
        logInfo('[UnifiedAudio] Microphone analyzer created during initialize');
      }

      // Create TTS audio element - maintain ONE across the session
      if (!this.ttsEl) {
        this.ttsEl = new Audio();
        this.ttsEl.preload = "auto";
        this.ttsEl.crossOrigin = "anonymous";
        this.ttsEl.addEventListener("canplay", () => {
          this.aiReady = true;
          logInfo('[UnifiedAudio] TTS element ready for playback');
        });
        this.ttsEl.addEventListener("ended", () => {
          try { 
            this.stopBargeInMonitoring(); 
            // Cleanup object URL when audio ends
            if (this.ttsEl?.src && this.ttsEl.src.startsWith('blob:')) {
              URL.revokeObjectURL(this.ttsEl.src);
            }
          } catch {}
        });
        this.ttsEl.addEventListener("error", (e) => {
          console.error("[UnifiedAudio] TTS element error", e);
        });

        // Bind TTS event handlers as specified
        this.ttsEl.onplay = () => console.info('[TTS] start', Date.now());
        this.ttsEl.onended = () => console.info('[TTS] end', Date.now());
        this.ttsEl.onpause = () => console.info('[TTS] pause', Date.now());

        logInfo('[UnifiedAudio] TTS audio element created');
      }

      // Initialize speech recognition
      this.speech = createEnhancedSpeech({
        onFinal: (text: string) => this.config.onFinalResult?.(text),
        onBargeIn: this.config.onBargeIn
      });

      if (!this.speech) {
        throw new Error('Failed to create enhanced speech recognition');
      }

      // Start health monitoring
      this.startHealthMonitoring();

      this._isInitialized = true;
      logInfo('[UnifiedAudio] Pipeline initialized successfully');

      // Notify mic track is ready if we have one
      if (this.config.onMicTrackReady && this._micTrack) {
        this.config.onMicTrackReady(this._micTrack);
      }

    } catch (error) {
      logError('[UnifiedAudio] Failed to initialize pipeline:', error);
      throw error;
    }
  }

  async playTTS(text: string, turnId: string): Promise<void> {
    if (this.isCleaningUp) {
      logWarn('[UnifiedAudio] Cannot play TTS during cleanup');
      return;
    }

    // Guard: ensure initialized first
    await this.initialize();

    // Stop any existing TTS
    this.stopTTS();

    // Set new abort controller
    this.ttsAbortController = new AbortController();
    
    logInfo(`[TTS] start ${Date.now()}`);
    this.config.onTTSStart?.(turnId);

    // Record TTS start time for grace window
    this.ttsStartTime = Date.now();

    // Gate ASR during TTS
    this.speech?.setTTSPlaying(true);

    // Start AI analyzer at TTS start
    this.startBargeInMonitoring();

    try {
      // Check if we should use client TTS fallback
      if (process.env.NEXT_PUBLIC_TTS_MODE === 'client' && typeof window !== 'undefined' && window.speechSynthesis) {
        await this.playClientTTS(text, turnId);
        return;
      }

      // Try server TTS
      const res = await fetch(`/api/tts?text=${encodeURIComponent(text)}`, { 
        signal: this.ttsAbortController.signal 
      });
      
      if (!res.ok || res.status === 204) {
        // Server TTS failed or returned no content, fall back to client
        logWarn('[UnifiedAudio] Server TTS failed, falling back to client TTS');
        await this.playClientTTS(text, turnId);
        return;
      }
      
      const data = await res.arrayBuffer();
      const mime = res.headers.get("content-type") || "audio/mpeg";
      const blob = new Blob([data], { type: mime });
      const objectUrl = URL.createObjectURL(blob);

      // Wire analyzers before playback (only for server TTS)
      if (this.audioContext && this.ttsEl) {
        if (!this.aiSource) {
          this.aiSource = this.audioContext.createMediaElementSource(this.ttsEl);
          this.aiAnalyser = this.audioContext.createAnalyser();
          this.aiAnalyser.fftSize = 2048; // As specified in requirements
          this.aiSource.connect(this.aiAnalyser);
          // Also route to output so audio is actually heard:
          this.aiSource.connect(this.audioContext.destination);
          logInfo('[UnifiedAudio] AI_ANALYZER_READY:true');
        }
      }

      // Assign and play
      this.ttsEl!.src = objectUrl;
      await this.ttsEl!.play();
      
      logInfo(`[UnifiedAudio] TTS playing: "${text}"`);

    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        logInfo('[UnifiedAudio] TTS aborted');
      } else {
        logError(`[UnifiedAudio] TTS failed:`, error);
        this.config.onTTSError?.(error as Error);
      }
    } finally {
      // Always ensure proper cleanup on completion/abort/error
      this.stopBargeInMonitoring();
      this.speech?.setTTSPlaying(false);
      this.speech?.startQuietGate();
      this.config.onTTSEnd?.(turnId);
    }
  }

  private async playClientTTS(text: string, turnId: string): Promise<void> {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      throw new Error('Client TTS not available');
    }

    // In client TTS mode, set aiAnalyzer to null since we don't have audio element
    if (process.env.NEXT_PUBLIC_TTS_MODE === 'client') {
      this.aiAnalyser = null;
    }

    return new Promise((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      
      utterance.onstart = () => {
        logInfo('[UnifiedAudio] Client TTS started');
      };
      
      utterance.onend = () => {
        logInfo(`[TTS] end ${Date.now()}`);
        this.stopBargeInMonitoring();
        this.speech?.setTTSPlaying(false);
        this.speech?.startQuietGate();
        this.config.onTTSEnd?.(turnId);
        resolve();
      };
      
      utterance.onerror = (event: SpeechSynthesisErrorEvent) => {
        logError('[UnifiedAudio] Client TTS error:', event);
        this.stopBargeInMonitoring();
        this.speech?.setTTSPlaying(false);
        this.speech?.startQuietGate();
        this.config.onTTSEnd?.(turnId);
        this.config.onTTSError?.(new Error(`Client TTS error: ${event.error}`));
        reject(new Error(`Client TTS error: ${event.error}`));
      };

      window.speechSynthesis.speak(utterance);
    });
  }

  stopTTS(): void {
    // Never throw if no abort controller
    if (this.ttsAbortController) {
      try { 
        this.ttsAbortController.abort(); 
      } catch {}
      this.ttsAbortController = null;
    }
    
    try { 
      this.ttsEl?.pause(); 
    } catch {}
    
    if (this.ttsEl) {
      this.ttsEl.currentTime = 0;
      // Cleanup object URL if it exists
      if (this.ttsEl.src && this.ttsEl.src.startsWith('blob:')) {
        URL.revokeObjectURL(this.ttsEl.src);
      }
    }

    // Stop barge-in monitoring
    this.stopBargeInMonitoring();
    
    // Ensure ASR is properly un-gated
    this.speech?.setTTSPlaying(false);
    this.speech?.startQuietGate();
    
    logInfo('[UnifiedAudio] TTS stopped');
  }

  private startBargeInMonitoring(): void {
    if (this.bargeInMonitoring) return;

    // Check if mic is ready before starting barge-in monitoring
    if (!this.isMicReady()) {
      logInfo('[UnifiedAudio] Mic not ready, skipping barge-in monitoring');
      return;
    }

    // Check if we're in client TTS mode
    const isClientTTSMode = process.env.NEXT_PUBLIC_TTS_MODE === 'client';

    if (isClientTTSMode) {
      // In client TTS mode, only monitor mic analyzer (no AI analyzer)
      this.bargeInMonitoring = true;
      logInfo('[UnifiedAudio] BARGE_MONITORING_START mic:true ai:false (client TTS mode)');
      logDebug('[UnifiedAudio] Starting barge-in monitoring (client TTS mode)');

      this.bargeInInterval = setInterval(() => {
        this.checkBargeInClientMode();
      }, this.BARGE_IN_CHECK_INTERVAL);
    } else {
      // In server TTS mode, require BOTH mic analyser and aiAnalyser
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
            logInfo('[UnifiedAudio] AI_ANALYZER_READY:true (wired during barge-in start)');
          } catch (error) {
            logError('[UnifiedAudio] Failed to wire AI analyzer during barge-in start:', error);
          }
        }
        
        if (!this.aiAnalyser) {
          logInfo('[UnifiedAudio] AI analyzer not ready, skipping barge-in monitoring');
          return;
        }
      }

      this.bargeInMonitoring = true;
      logInfo('[UnifiedAudio] BARGE_MONITORING_START mic:true ai:true');
      logDebug('[UnifiedAudio] Starting barge-in monitoring (server TTS mode)');

      this.bargeInInterval = setInterval(() => {
        this.checkBargeIn();
      }, this.BARGE_IN_CHECK_INTERVAL);
    }
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
    logDebug('[UnifiedAudio] Stopped barge-in monitoring');
  }

  private checkBargeIn(): void {
    if (!this.micAnalyzer || !this.aiAnalyser) return;

    const now = Date.now();
    const micPower = this.rms(this.micAnalyzer);
    const aiPower = this.rms(this.aiAnalyser) || 0;

    // Check grace window - no barge-in allowed for first 350ms after TTS start
    const timeSinceTTSStart = now - this.ttsStartTime;
    if (timeSinceTTSStart < this.GRACE_WINDOW_MS) {
      return;
    }

    // Check if user is speaking while AI is talking
    if (micPower > this.MIC_THRESHOLD && micPower > aiPower * 1.5) {
      this.bargeInStableCount++;
      
      // Require stability for 80ms before triggering barge-in
      if (this.bargeInStableCount * this.BARGE_IN_CHECK_INTERVAL >= this.BARGE_IN_STABILITY_MS) {
        const dt = now - this.ttsStartTime;
        logInfo(`[BARGE-IN] micPower:${micPower.toFixed(3)}, aiPower:${aiPower.toFixed(3)}, dt:${dt}ms`);
        
        // On trigger: pause ttsEl and stop the monitor loop — do not tear down the whole audio pipeline or stop recognition
        this.ttsEl?.pause();
        this.stopBargeInMonitoring();
        this.config.onBargeIn?.();
      }
    } else {
      // Reset stability counter if conditions not met
      this.bargeInStableCount = 0;
    }
  }

  private checkBargeInClientMode(): void {
    if (!this.micAnalyzer) return;

    const micPower = this.rms(this.micAnalyzer);

    // In client TTS mode, only check mic level for barge-in
    // This is a simplified approach - you might want to add more sophisticated logic
    if (micPower > 0.15) { // Slightly higher threshold since we're not comparing to AI audio
      logInfo(`[UnifiedAudio] BARGE_SPEECH_DETECTED (client mode) rms:${micPower.toFixed(3)}`);
      
      // Stop TTS and trigger barge-in
      this.stopTTS();
      this.config.onBargeIn?.();
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

  // Public method to get current mic RMS for debug overlay
  getMicRMS(): number {
    if (!this.micAnalyzer) return 0;
    return this.rms(this.micAnalyzer);
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
      logDebug('[Health]', health);
    }, 5000);
  }

  // === CLEANUP ===

  cleanup(): void {
    if (this.isCleaningUp) {
      logDebug('[UnifiedAudio] Cleanup already in progress');
      return;
    }

    this.isCleaningUp = true;
    logInfo('[UnifiedAudio] DISCONNECT_REASON:cleanup_requested');
    logInfo('[UnifiedAudio] Cleaning up pipeline');

    // Stop health monitoring
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }

    // Don't throw if there's no controller
    try { 
      this.stopTTS(); 
    } catch {}

    // Stop speech recognition
    if (this.speech) {
      this.speech.stop();
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

    logInfo('[UnifiedAudio] Pipeline cleanup complete');
  }

  // Force cleanup when session is truly ending (not HMR)
  forceCleanup(): void {
    logInfo('[UnifiedAudio] Force cleanup - closing AudioContext');
    
    // First do normal cleanup
    this.cleanup();
    
    // Then close the AudioContext
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
      this.audioContext = null;
      logInfo('[UnifiedAudio] AudioContext closed');
    }
  }

  // === PUBLIC API ===

  isTTSPlaying(): boolean {
    return this.ttsEl ? !this.ttsEl.paused && !!this.ttsEl.src : false;
  }

  getCurrentTurnId(): string | null {
    return null; // Not used in this implementation
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
      this.speech.start();
    }
  }

  // Stop speech recognition
  stopSpeech(): void {
    if (this.speech) {
      this.speech.stop();
    }
  }
}

// Singleton instance
let unifiedPipeline: UnifiedAudioPipeline | null = null;

export function getUnifiedAudioPipeline(config?: UnifiedAudioPipelineConfig): UnifiedAudioPipeline {
  if (!unifiedPipeline) {
    unifiedPipeline = new UnifiedAudioPipeline(config || {});
  }
  return unifiedPipeline;
}

export function cleanupUnifiedAudioPipeline(): void {
  if (unifiedPipeline) {
    unifiedPipeline.cleanup();
    unifiedPipeline = null;
  }
}
