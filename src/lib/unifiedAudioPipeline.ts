// Unified Audio Pipeline - Single source of truth for all audio and speech recognition
// Consolidates: AudioManager, LegacyAudioManager, BargeInDetector, ASRManager, TTSPlayer

import { info, warn, error, debug } from './logger';
import { createEnhancedSpeech, type EnhancedSpeechControls } from './speech/enhancedSpeech';
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

export class UnifiedAudioPipeline {
  private audioContext: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private _micTrack: MediaStreamTrack | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micAnalyzer: AnalyserNode | null = null;
  private aiSource: MediaStreamAudioSourceNode | null = null;
  private aiAnalyser: AnalyserNode | null = null;
  private ttsEl: HTMLAudioElement | null = null;
  private ttsAbortController: AbortController | null = null;
  private speech: EnhancedSpeechControls | null = null;
  private bargeInMonitoring: boolean = false;
  private bargeInInterval: NodeJS.Timeout | null = null;
  private bargeInTimer: NodeJS.Timeout | null = null;
  private bargeInTriggered: boolean = false; // Track if barge-in has been triggered for current TTS
  private healthInterval: NodeJS.Timeout | null = null;
  private restartDebounceTimer: NodeJS.Timeout | null = null;
  private _isInitialized: boolean = false;
  private isCleaningUp: boolean = false;
  private config: UnifiedAudioPipelineConfig;
  private currentTurnId: string | null = null; // Track current TTS turn
  
  // Barge-in state
  private aiReady: boolean = false;
  private ttsStartTime: number = 0;
  private bargeInStableCount: number = 0;
  private lastBargeInCheck: number = 0;
  private lastRmsLogTime: number = 0;
  private lastLoggedRms: number = 0;
  
  // Constants
  private readonly MIC_THRESHOLD = 0.1;
  private readonly BARGE_IN_STABILITY_MS = 80;
  private readonly GRACE_WINDOW_MS = 350;
  private readonly BARGE_IN_CHECK_INTERVAL = 20; // ~50fps

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
          noiseSuppression: true, 
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
      this.micAnalyzer.fftSize = 256;
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
          onFinalResult: (text, confidence) => this.config.onFinalResult?.(text, confidence),
          onError: (error) => this.config.onSpeechError?.(error),
          onBargeIn: () => this.config.onBargeIn?.(),
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

    // Stop any existing TTS
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

    // Gate ASR during TTS
    this.speech?.setTTSPlaying(true);

    // Start AI analyzer at TTS start
    this.startBargeInMonitoring();

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
          warn('AUDIO', 'Client TTS failed, using beep fallback:', fallbackError);
          
          // Last resort: play a beep to maintain flow
          await this.playBeepFallback(turnId);
        }
      } else {
        // If we were already in client mode and it failed, use beep fallback
        warn('AUDIO', 'Client TTS failed, using beep fallback:', err);
        await this.playBeepFallback(turnId);
      }
    } finally {
      // Always ensure proper cleanup on completion/abort/error
      this.stopBargeInMonitoring();
      this.speech?.setTTSPlaying(false);
      this.speech?.startQuietGate();
      this.config.onTTSEnd?.(turnId);
      
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
      if (!this.aiSource) {
        this.aiSource = this.audioContext.createMediaElementSource(this.ttsEl);
        this.aiAnalyser = this.audioContext.createAnalyser();
        this.aiAnalyser.fftSize = 2048; // As specified in requirements
        this.aiSource.connect(this.aiAnalyser);
        // Also route to output so audio is actually heard:
        this.aiSource.connect(this.audioContext.destination);
        info('AUDIO', 'AI_ANALYZER_READY:true');
      }
    }

    // Assign and play
    this.ttsEl!.src = objectUrl;
    await this.ttsEl!.play();
    
    info('TTS', 'Server playback started', { turnId });
  }

  private async playClientTTS(text: string, turnId: string): Promise<void> {
    if (!('speechSynthesis' in window)) {
      throw new Error('SpeechSynthesis not available');
    }

    return new Promise<void>((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.9;
      utterance.pitch = 1.0;
      utterance.volume = 0.8;

      utterance.onend = () => {
        info('TTS', 'Client playback finished', { turnId });
        resolve();
      };

      utterance.onerror = (event) => {
        error('TTS', 'Client playback error:', event.error);
        reject(new Error(`Client TTS error: ${event.error}`));
      };

      speechSynthesis.speak(utterance);
      info('TTS', 'Client playback started', { turnId });
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
    
    // Restart speech recognition after TTS stops
    this.restartSpeechRecognition();
    
    info('AUDIO', 'TTS stopped');
  }

  private startBargeInMonitoring(): void {
    if (this.bargeInMonitoring) return;

    // Check if mic is ready before starting barge-in monitoring
    if (!this.isMicReady()) {
      info('AUDIO', 'Mic not ready, skipping barge-in monitoring');
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
    debug('AUDIO', 'Stopped barge-in monitoring');
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
        // Ensure barge-in is only triggered once per TTS playback (idempotent)
        if (this.bargeInTriggered) {
          return;
        }
        
        this.bargeInTriggered = true;
        const dt = now - this.ttsStartTime;
        info('BARGE-IN', `micPower:${micPower.toFixed(3)}, aiPower:${aiPower.toFixed(3)}, dt:${dt}ms`);
        
        // Stop/pause TTS promise chain once (idempotent)
        this.ttsEl?.pause();
        if (this.ttsAbortController) {
          this.ttsAbortController.abort();
        }
        
        // Stop barge-in monitoring immediately
        this.stopBargeInMonitoring();
        
        // Call pauseRecognitionLoop() -> (brief 100ms) -> startRecognitionLoop() to guarantee recognizer state is correct
        this.speech?.pauseRecognitionLoop();
        
        // Brief delay before restarting recognition to ensure clean state
        setTimeout(() => {
          this.speech?.startRecognitionLoop();
          info('BARGE-IN', 'ASR restarted after barge-in');
        }, 100);
        
        this.config.onBargeIn?.();
      }
    } else {
      // Reset stability counter if conditions not met
      this.bargeInStableCount = 0;
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

  // Force cleanup for testing scenarios
  forceCleanup(): void {
    info('AUDIO', 'Force cleanup initiated');
    this.cleanup();
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

