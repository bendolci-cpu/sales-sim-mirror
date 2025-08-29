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
}

export class UnifiedAudioPipeline {
  // Core audio context and state
  private audioContext: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private micTrack: MediaStreamTrack | null = null;
  private micAnalyzer: AnalyserNode | null = null;
  private aiAnalyzer: AnalyserNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  
  // Speech recognition
  private speechRecognition: EnhancedSpeechControls | null = null;
  private isRecognitionActive = false;
  
  // TTS playback
  private currentTTSAbortController: AbortController | null = null;
  private currentTTSTurnId: string | null = null;
  private audioElement: HTMLAudioElement | null = null;
  
  // Barge-in detection
  private bargeInMonitoring = false;
  private bargeInInterval: NodeJS.Timeout | null = null;
  private aiRMSThreshold = 20;
  private micRMSThreshold = 55;
  private bargeInDelay = 150; // ms to wait before barge-in
  private bargeInTimer: NodeJS.Timeout | null = null;
  
  // Health monitoring
  private healthInterval: NodeJS.Timeout | null = null;
  private lastHealthLog = 0;
  
  // Configuration
  private config: UnifiedAudioPipelineConfig;
  
  constructor(config: UnifiedAudioPipelineConfig = {}) {
    this.config = config;
  }
  
  // === INITIALIZATION ===
  
  async initialize(): Promise<void> {
    logInfo('[UnifiedAudio] Initializing pipeline');
    
    // Initialize audio context
    await this.initializeAudioContext();
    
    // Initialize microphone
    await this.initializeMicrophone();
    
    // Initialize speech recognition
    await this.initializeSpeechRecognition();
    
    // Start health monitoring
    this.startHealthMonitoring();
    
    logInfo('[UnifiedAudio] Pipeline initialized successfully');
  }
  
  private async initializeAudioContext(): Promise<void> {
    if (this.audioContext) return;
    
    this.audioContext = new AudioContext({ sampleRate: 24000 });
    await this.audioContext.resume();
    logInfo('[UnifiedAudio] AudioContext initialized at 24kHz');
  }
  
  private async initializeMicrophone(): Promise<void> {
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({ 
        audio: { 
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 24000
        } 
      });
      
      // Get the single mic track
      const tracks = this.micStream.getAudioTracks();
      if (tracks.length === 0) {
        throw new Error('No audio tracks found in mic stream');
      }
      
      this.micTrack = tracks[0];
      logInfo(`[UnifiedAudio] Mic track ready: ${this.micTrack.id}`);
      
      // Setup mic analyzer
      if (this.audioContext) {
        this.micAnalyzer = this.audioContext.createAnalyser();
        this.micAnalyzer.fftSize = 256;
        this.micAnalyzer.smoothingTimeConstant = 0.8;
        
        this.micSource = this.audioContext.createMediaStreamSource(this.micStream);
        this.micSource.connect(this.micAnalyzer);
      }
      
      // Notify that mic track is ready
      this.config.onMicTrackReady?.(this.micTrack);
      
      logInfo('[UnifiedAudio] Microphone initialized with analyzer');
    } catch (error) {
      logError('[UnifiedAudio] Failed to initialize microphone:', error);
      throw error;
    }
  }
  
  private async initializeSpeechRecognition(): Promise<void> {
    this.speechRecognition = createEnhancedSpeech({
      onInterim: (text: string) => {
        // Only show interim results when not in TTS
        if (!this.currentTTSTurnId) {
          logDebug('[UnifiedAudio] Interim speech:', text);
        }
      },
      onBargeIn: () => {
        // Trigger barge-in if TTS is playing
        if (this.currentTTSTurnId) {
          logInfo('[UnifiedAudio] Barge-in detected - stopping TTS');
          this.stopTTS();
          this.config.onBargeIn?.();
        }
      },
      onSpeechStart: () => {
        logDebug('[UnifiedAudio] Speech started');
      },
      onSpeechEnd: () => {
        logDebug('[UnifiedAudio] Speech ended');
      }
    });
    
    if (!this.speechRecognition) {
      throw new Error('Failed to create speech recognition');
    }
    
    // Start recognition immediately and keep it running
    await this.speechRecognition.start();
    this.isRecognitionActive = true;
    logInfo('[UnifiedAudio] Speech recognition started');
  }
  
  // === TTS PLAYBACK ===
  
  async playTTS(text: string, turnId: string): Promise<void> {
    // Stop any existing TTS
    this.stopTTS();
    
    // Create new abort controller
    this.currentTTSAbortController = new AbortController();
    this.currentTTSTurnId = turnId;
    
    logInfo(`[UnifiedAudio] Starting TTS for turn ${turnId}: "${text}"`);
    this.config.onTTSStart?.(turnId);
    
    try {
      // Generate TTS audio URL
      const response = await fetch(`/api/tts?text=${encodeURIComponent(text)}`);
      if (!response.ok) {
        throw new Error(`TTS API error: ${response.status}`);
      }
      
      const data = await response.json();
      const audioUrl = data.audioUrl;
      
      // Create or reuse audio element
      if (!this.audioElement) {
        this.audioElement = document.createElement('audio');
        this.audioElement.volume = 1.0; // Full volume
        this.audioElement.muted = false; // Not muted
        this.audioElement.style.display = 'none'; // Hidden
        document.body.appendChild(this.audioElement);
      }
      
      this.audioElement.src = audioUrl;
      
      // Setup AI analyzer for barge-in detection
      this.setupAIAnalyzer(this.audioElement);
      
      // Start barge-in monitoring
      this.startBargeInMonitoring();
      
      // Play audio
      await new Promise<void>((resolve, reject) => {
        const abortController = this.currentTTSAbortController;
        if (!abortController) {
          reject(new Error('TTS abort controller not available'));
          return;
        }
        
        this.audioElement!.addEventListener('canplaythrough', () => {
          if (abortController.signal.aborted) {
            reject(new Error('TTS aborted during load'));
            return;
          }
          
          this.audioElement!.play().then(() => {
            logInfo(`[UnifiedAudio] TTS playing for turn ${turnId}`);
          }).catch(reject);
        }, { once: true });
        
        this.audioElement!.addEventListener('ended', () => {
          if (!abortController.signal.aborted) {
            logInfo(`[UnifiedAudio] TTS completed for turn ${turnId}`);
            this.config.onTTSEnd?.(turnId);
          }
          resolve();
        }, { once: true });
        
        this.audioElement!.addEventListener('error', (e) => {
          reject(new Error(`TTS playback error: ${e}`));
        }, { once: true });
        
        abortController.signal.addEventListener('abort', () => {
          reject(new Error('TTS aborted'));
        }, { once: true });
      });
      
    } catch (error) {
      logError(`[UnifiedAudio] TTS failed for turn ${turnId}:`, error);
      this.config.onTTSError?.(error as Error);
    } finally {
      this.stopTTS();
    }
  }
  
  stopTTS(): void {
    if (this.currentTTSAbortController) {
      this.currentTTSAbortController.abort();
      this.currentTTSAbortController = null;
    }
    
    if (this.currentTTSTurnId) {
      logInfo(`[UnifiedAudio] TTS stopped for turn ${this.currentTTSTurnId}`);
      this.currentTTSTurnId = null;
    }
    
    // Stop barge-in monitoring
    this.stopBargeInMonitoring();
  }
  
  private setupAIAnalyzer(audioElement: HTMLAudioElement): void {
    if (!this.audioContext) return;
    
    // Clean up existing AI analyzer
    if (this.aiAnalyzer) {
      this.aiAnalyzer.disconnect();
    }
    
    try {
      this.aiAnalyzer = this.audioContext.createAnalyser();
      this.aiAnalyzer.fftSize = 256;
      this.aiAnalyzer.smoothingTimeConstant = 0.8;
      
      const aiSource = this.audioContext.createMediaElementSource(audioElement);
      aiSource.connect(this.aiAnalyzer);
      
      logDebug('[UnifiedAudio] AI analyzer setup complete');
    } catch (error) {
      logWarn('[UnifiedAudio] Failed to setup AI analyzer:', error);
    }
  }
  
  // === BARGE-IN DETECTION ===
  
  private startBargeInMonitoring(): void {
    if (this.bargeInMonitoring) return;
    
    this.bargeInMonitoring = true;
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
    if (!this.currentTTSTurnId || !this.micAnalyzer || !this.aiAnalyzer) return;
    
    const micRMS = this.calculateRMS(this.micAnalyzer);
    const aiRMS = this.calculateRMS(this.aiAnalyzer);
    
    // Barge-in condition: AI is quiet and mic is loud
    if (aiRMS < this.aiRMSThreshold && micRMS > this.micRMSThreshold) {
      if (!this.bargeInTimer) {
        // Start barge-in timer
        this.bargeInTimer = setTimeout(() => {
          logInfo(`[UnifiedAudio] Barge-in detected - micRMS:${micRMS.toFixed(1)}, aiRMS:${aiRMS.toFixed(1)}`);
          this.stopTTS();
          this.config.onBargeIn?.();
        }, this.bargeInDelay);
      }
    } else {
      // Reset barge-in timer
      if (this.bargeInTimer) {
        clearTimeout(this.bargeInTimer);
        this.bargeInTimer = null;
      }
    }
  }
  
  private calculateRMS(analyser: AnalyserNode): number {
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);
    
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i] * dataArray[i];
    }
    return Math.sqrt(sum / dataArray.length);
  }
  
  // === HEALTH MONITORING ===
  
  private startHealthMonitoring(): void {
    this.healthInterval = setInterval(() => {
      const now = Date.now();
      if (now - this.lastHealthLog >= 1000) { // Log once per second
        this.logHealth();
        this.lastHealthLog = now;
      }
    }, 1000);
  }
  
  private logHealth(): void {
    const health = {
      recognizer: this.isRecognitionActive,
      mic_live: this.micTrack?.readyState === 'live',
      tts_playing: this.currentTTSTurnId !== null,
      barge_enabled: this.bargeInMonitoring,
      gating: this.currentTTSTurnId !== null, // Gate on TTS
      recording: this.isRecognitionActive
    };
    
    logDebug('[Health]', health);
  }
  
  // === CLEANUP ===
  
  cleanup(): void {
    logInfo('[UnifiedAudio] Cleaning up pipeline');
    
    // Stop health monitoring
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
    
    // Stop TTS
    this.stopTTS();
    
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
    if (this.audioElement) {
      this.audioElement.remove();
      this.audioElement = null;
    }
    
    // Clean up audio context
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    
    // Clear analyzers
    this.micAnalyzer = null;
    this.aiAnalyzer = null;
    this.micSource = null;
    this.micTrack = null;
    
    logInfo('[UnifiedAudio] Pipeline cleanup complete');
  }
  
  // === PUBLIC API ===
  
  isTTSPlaying(): boolean {
    return this.currentTTSTurnId !== null;
  }
  
  getCurrentTurnId(): string | null {
    return this.currentTTSTurnId;
  }
  
  getMicStream(): MediaStream | null {
    return this.micStream;
  }
  
  getMicTrack(): MediaStreamTrack | null {
    return this.micTrack;
  }
}

// Singleton instance
let unifiedPipeline: UnifiedAudioPipeline | null = null;

export function getUnifiedAudioPipeline(config?: UnifiedAudioPipelineConfig): UnifiedAudioPipeline {
  if (!unifiedPipeline) {
    unifiedPipeline = new UnifiedAudioPipeline(config);
  }
  return unifiedPipeline;
}

export function cleanupUnifiedAudioPipeline(): void {
  if (unifiedPipeline) {
    unifiedPipeline.cleanup();
    unifiedPipeline = null;
  }
}
