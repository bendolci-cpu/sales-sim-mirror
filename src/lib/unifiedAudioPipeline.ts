// Unified Audio Pipeline - Single source of truth for all audio and speech recognition
// Consolidates: AudioManager, LegacyAudioManager, BargeInDetector, ASRManager, TTSPlayer

import { logInfo, logDebug, logWarn, logError } from './logger';
import { sendMessage } from './messageDispatcher';
import { createEnhancedSpeech, type EnhancedSpeechControls } from './speech/enhancedSpeech';

export interface UnifiedAudioPipelineConfig {
  onBargeIn?: () => void;
  onTTSStart?: (turnId: string) => void;
  onTTSEnd?: (turnId: string) => void;
  onTTSError?: (error: Error) => void;
  onMicTrackReady?: (track: MediaStreamTrack) => void;
  onFinalResult?: (text: string) => void; // Added for EnhancedSpeechRecognition
  onError?: (error: Error) => void; // Added for EnhancedSpeechRecognition
}

export class UnifiedAudioPipeline {
  private audioContext: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private micTrack: MediaStreamTrack | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micAnalyzer: AnalyserNode | null = null;
  private aiSource: MediaElementAudioSourceNode | null = null;
  private aiAnalyser: AnalyserNode | null = null;
  private ttsAudioEl: HTMLAudioElement | null = null;
  private ttsAbortController: AbortController | null = null;
  private speechRecognition: EnhancedSpeechRecognition | null = null;
  private bargeInMonitoring: boolean = false;
  private bargeInInterval: NodeJS.Timeout | null = null;
  private bargeInTimer: NodeJS.Timeout | null = null;
  private healthInterval: NodeJS.Timeout | null = null;
  private isInitialized: boolean = false;
  private isCleaningUp: boolean = false;
  private config: UnifiedAudioPipelineConfig;

  constructor(config: UnifiedAudioPipelineConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized || this.isCleaningUp) {
      return;
    }

    try {
      logInfo('[UnifiedAudio] Initializing pipeline');
      
      // Create AudioContext after user gesture (this should be called from a user action)
      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ 
          sampleRate: 24000 
        });
        logInfo('[UnifiedAudio] AudioContext created');
      }

      // Create TTS audio element
      if (!this.ttsAudioEl) {
        this.ttsAudioEl = new Audio();
        this.ttsAudioEl.preload = "auto";
        this.ttsAudioEl.crossOrigin = "anonymous";
        this.ttsAudioEl.addEventListener("ended", () => {
          try { 
            this.stopBargeInMonitoring(); 
            // Cleanup object URL when audio ends
            if (this.ttsAudioEl?.src && this.ttsAudioEl.src.startsWith('blob:')) {
              URL.revokeObjectURL(this.ttsAudioEl.src);
            }
          } catch {}
        });
        this.ttsAudioEl.addEventListener("error", (e) => {
          console.error("[UnifiedAudio] TTS element error", e);
        });
        logInfo('[UnifiedAudio] TTS audio element created');
      }

      // Get microphone access
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 24000,
          channelCount: 1
        }
      });

      this.micTrack = this.micStream.getAudioTracks()[0];
      if (!this.micTrack) {
        throw new Error('No audio track found in microphone stream');
      }

      // Setup microphone analyzer
      if (this.audioContext && this.micTrack) {
        this.micSource = this.audioContext.createMediaStreamSource(this.micStream);
        this.micAnalyzer = this.audioContext.createAnalyser();
        this.micAnalyzer.fftSize = 256;
        this.micAnalyzer.smoothingTimeConstant = 0.8;
        this.micSource.connect(this.micAnalyzer);
        logInfo('[UnifiedAudio] Microphone analyzer ready');
      }

      // Initialize speech recognition
      this.speechRecognition = new EnhancedSpeechRecognition({
        onFinalResult: this.config.onFinalResult,
        onBargeIn: this.config.onBargeIn,
        onError: this.config.onError
      });

      // Start health monitoring
      this.startHealthMonitoring();

      this.isInitialized = true;
      logInfo('[UnifiedAudio] Pipeline initialized successfully');

      // Notify mic track is ready
      if (this.config.onMicTrackReady && this.micTrack) {
        this.config.onMicTrackReady(this.micTrack);
      }

    } catch (error) {
      logError('[UnifiedAudio] Failed to initialize pipeline:', error);
      throw error;
    }
  }

  async playTTS(text: string, urlOrEndpoint: string): Promise<void> {
    if (this.isCleaningUp) {
      logWarn('[UnifiedAudio] Cannot play TTS during cleanup');
      return;
    }

    // Guard: ensure initialized first
    await this.initialize();

    // Stop any existing TTS
    if (this.ttsAbortController) { 
      try { 
        this.stopTTS(); 
      } catch {} 
    }

    this.ttsAbortController = new AbortController();
    
    logInfo(`[UnifiedAudio] Starting TTS: "${text}"`);
    this.config.onTTSStart?.(text);

    try {
      // Fetch the audio as ArrayBuffer
      const res = await fetch(urlOrEndpoint, { 
        signal: this.ttsAbortController.signal 
      });
      
      if (!res.ok) {
        throw new Error(`TTS fetch failed: ${res.status}`);
      }
      
      const data = await res.arrayBuffer();
      const mime = res.headers.get("content-type") || "audio/mpeg";
      const blob = new Blob([data], { type: mime });
      const objectUrl = URL.createObjectURL(blob);

      // Wire analyzers before playback
      if (this.audioContext && this.ttsAudioEl) {
        if (!this.aiSource) {
          this.aiSource = this.audioContext.createMediaElementSource(this.ttsAudioEl);
          this.aiAnalyser = this.audioContext.createAnalyser();
          this.aiSource.connect(this.aiAnalyser);
          // Also route to output so audio is actually heard:
          this.aiSource.connect(this.audioContext.destination);
          logInfo('[UnifiedAudio] AI_ANALYZER_READY:true');
        }
      }

      // Assign and play
      this.ttsAudioEl!.src = objectUrl;
      await this.ttsAudioEl!.play();
      
      // Start barge-in monitoring (require both mic and AI analyzers)
      this.startBargeInMonitoring();

      logInfo(`[UnifiedAudio] TTS playing: "${text}"`);

    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        logInfo('[UnifiedAudio] TTS aborted');
      } else {
        logError(`[UnifiedAudio] TTS failed:`, error);
        this.config.onTTSError?.(error as Error);
      }
    }
  }

  stopTTS(): void {
    const ctrl = this.ttsAbortController;
    this.ttsAbortController = null;
    
    try { 
      this.ttsAudioEl?.pause(); 
    } catch {}
    
    if (this.ttsAudioEl) {
      this.ttsAudioEl.currentTime = 0;
      // Cleanup object URL if it exists
      if (this.ttsAudioEl.src && this.ttsAudioEl.src.startsWith('blob:')) {
        URL.revokeObjectURL(this.ttsAudioEl.src);
      }
    }
    
    if (ctrl) { 
      try { 
        ctrl.abort(); 
      } catch {} 
    }

    // Stop barge-in monitoring
    this.stopBargeInMonitoring();
    
    logInfo('[UnifiedAudio] TTS stopped');
  }

  private startBargeInMonitoring(): void {
    if (this.bargeInMonitoring) return;

    // Only start if BOTH mic analyser and aiAnalyser exist
    if (!this.micAnalyzer || !this.aiAnalyser) {
      logWarn('[UnifiedAudio] Analyzers not ready for barge-in monitoring - mic:', !!this.micAnalyzer, 'ai:', !!this.aiAnalyser);
      return;
    }

    this.bargeInMonitoring = true;
    logInfo('[UnifiedAudio] BARGE_MONITORING_START mic:true ai:true');
    logDebug('[UnifiedAudio] Starting barge-in monitoring');

    this.bargeInInterval = setInterval(() => {
      this.checkBargeIn();
    }, 16); // ~60fps
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
    logDebug('[UnifiedAudio] Stopped barge-in monitoring');
  }

  private checkBargeIn(): void {
    if (!this.micAnalyzer || !this.aiAnalyser) return;

    const micRMS = this.calculateRMS(this.micAnalyzer);
    const aiRMS = this.calculateRMS(this.aiAnalyser);

    // Check if user is speaking while AI is talking
    if (micRMS > 0.1 && aiRMS > 0.05) {
      logInfo(`[UnifiedAudio] BARGE_SPEECH_DETECTED rms:${micRMS.toFixed(3)}`);
      
      // Stop TTS and trigger barge-in
      this.stopTTS();
      this.config.onBargeIn?.();
    }
  }

  private calculateRMS(analyzer: AnalyserNode): number {
    const dataArray = new Uint8Array(analyzer.frequencyBinCount);
    analyzer.getByteFrequencyData(dataArray);
    
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i] * dataArray[i];
    }
    
    return Math.sqrt(sum / dataArray.length) / 255;
  }

  private startHealthMonitoring(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
    }

    this.healthInterval = setInterval(() => {
      const health = {
        audioContext: this.audioContext?.state || 'null',
        micStream: !!this.micStream,
        micTrack: !!this.micTrack,
        ttsPlaying: !!this.ttsAudioEl?.src && !this.ttsAudioEl?.paused,
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
    if (this.speechRecognition) {
      this.speechRecognition.stop();
      this.speechRecognition = null;
    }

    // Stop microphone
    if (this.micStream) {
      this.micStream.getTracks().forEach(track => track.stop());
      this.micStream = null;
    }

    // Clean up audio element
    if (this.ttsAudioEl) {
      this.ttsAudioEl.remove();
      this.ttsAudioEl = null;
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
    this.micTrack = null;

    this.isInitialized = false;
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
    return this.ttsAudioEl ? !this.ttsAudioEl.paused && !!this.ttsAudioEl.src : false;
  }

  getCurrentTurnId(): string | null {
    return null; // Not used in this implementation
  }

  getMicStream(): MediaStream | null {
    return this.micStream;
  }

  getMicTrack(): MediaStreamTrack | null {
    return this.micTrack;
  }

  isInitialized(): boolean {
    return this.isInitialized;
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
