// Microphone management for CloserCoach-style live voice UX
// Mic always live with AEC, 24kHz mono format
import { logInfo, logDebug, logChange } from "@/lib/logger";

export class MicrophoneManager {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micAnalyzer: AnalyserNode | null = null;
  private micGain: GainNode | null = null;
  
  // VAD state
  private isListening = false;
  private ambientLevel = 0;
  private speechThreshold = 0;
  private vadWindow = 0;
  private vadStartTime = 0;
  
  // Callbacks
  private onSpeechStart?: () => void;
  private onSpeechEnd?: () => void;
  private onVadUpdate?: (isSpeaking: boolean, level: number) => void;
  
  constructor() {}
  
  // Singleton mic stream getter - reuse if already created and live
  async getMicStream(): Promise<MediaStream> {
    if (this.stream) {
      const track = this.stream.getAudioTracks()[0];
      if (track && track.readyState === 'live') {
        logChange('mic-stream-state', track.readyState, '[Mic] Reusing existing mic stream', { 
          id: track.id, 
          enabled: track.enabled, 
          muted: track.muted, 
          state: track.readyState 
        });
        return this.stream;
      }
    }
    
    return this.initialize();
  }
  
  // Get the mic track directly
  getMicTrack(): MediaStreamTrack | null {
    if (!this.stream) return null;
    const tracks = this.stream.getAudioTracks();
    return tracks.length > 0 ? tracks[0] : null;
  }
  
  // Check if mic is live
  isLive(): boolean {
    const track = this.getMicTrack();
    return track ? track.readyState === 'live' : false;
  }
  
  // Initialize microphone with AEC and proper format
  async initialize(): Promise<MediaStream> {
    if (this.stream) {
      const track = this.stream.getAudioTracks()[0];
      if (track && track.readyState === 'live') {
        logChange('mic-stream-state', track.readyState, '[Mic] Reusing existing mic stream', { 
          id: track.id, 
          enabled: track.enabled, 
          muted: track.muted, 
          state: track.readyState 
        });
        return this.stream;
      }
    }
    
    try {
      // Request mic with AEC first, 24kHz mono
      const constraints: MediaStreamConstraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false, // Disable auto gain for better VAD
          channelCount: 1, // Mono
          sampleRate: 24000, // 24kHz
          sampleSize: 16, // 16-bit
          // Additional constraints for better quality
          googEchoCancellation: true,
          googNoiseSuppression: true,
          googAutoGainControl: false,
          googHighpassFilter: true,
          googTypingNoiseDetection: true,
          googAudioMirroring: false
        } as any
      };
      
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      const track = this.stream.getAudioTracks()[0];
      logInfo('[Mic] Initialized with AEC, 24kHz mono', { 
        id: track.id, 
        enabled: track.enabled, 
        muted: track.muted, 
        state: track.readyState 
      });
      
      return this.stream;
    } catch (error) {
      console.error('[Mic] Failed to initialize:', error);
      throw error;
    }
  }
  
  // Get the microphone stream (never disable the track)
  getStream(): MediaStream | null {
    return this.stream;
  }
  
  // Ensure mic track is always enabled
  ensureMicEnabled(): void {
    if (this.stream) {
      const audioTracks = this.stream.getAudioTracks();
      audioTracks.forEach(track => {
        if (!track.enabled) {
          track.enabled = true;
          console.log('[Mic] Re-enabled mic track', { 
            id: track.id, 
            enabled: track.enabled, 
            muted: track.muted, 
            state: track.readyState 
          });
        }
      });
    }
  }
  
  // Setup audio analysis for VAD
  setupAudioAnalysis(audioContext: AudioContext): void {
    if (!this.stream || this.audioContext) return;
    
    this.audioContext = audioContext;
    
    // Create audio nodes
    this.micSource = audioContext.createMediaStreamSource(this.stream);
    this.micAnalyzer = audioContext.createAnalyser();
    this.micGain = audioContext.createGain();
    
    // Configure analyzer
    this.micAnalyzer.fftSize = 256;
    this.micAnalyzer.smoothingTimeConstant = 0.8;
    
    // Connect: mic -> gain -> analyzer (for VAD analysis only, NOT to speakers)
    this.micSource.connect(this.micGain);
    this.micGain.connect(this.micAnalyzer);
    // DO NOT connect to destination - this causes echo!
    // this.micAnalyzer.connect(audioContext.destination);
    
    console.log('[Mic] Audio analysis setup complete');
  }
  
  // Start VAD monitoring
  startVadMonitoring(callbacks: {
    onSpeechStart?: () => void;
    onSpeechEnd?: () => void;
    onVadUpdate?: (isSpeaking: boolean, level: number) => void;
  }): void {
    this.onSpeechStart = callbacks.onSpeechStart;
    this.onSpeechEnd = callbacks.onSpeechEnd;
    this.onVadUpdate = callbacks.onVadUpdate;
    
    this.isListening = true;
    this.calibrateAmbientLevel();
    this.startVadLoop();
    
    console.log('[Mic] VAD monitoring started');
  }
  
  // Stop VAD monitoring (DOES NOT stop the mic track)
  stopVadMonitoring(): void {
    this.isListening = false;
    console.log('[Mic] VAD monitoring stopped');
  }
  
  // Calibrate ambient noise level (500ms)
  private async calibrateAmbientLevel(): Promise<void> {
    if (!this.micAnalyzer) return;
    
    const samples: number[] = [];
    const sampleCount = 25; // 500ms at 50fps
    
    return new Promise((resolve) => {
      const sample = () => {
        const level = this.getCurrentLevel();
        samples.push(level);
        
        if (samples.length < sampleCount) {
          requestAnimationFrame(sample);
        } else {
          // Calculate ambient level (average of top 80%)
          samples.sort((a, b) => b - a);
          const topCount = Math.floor(samples.length * 0.8);
          this.ambientLevel = samples.slice(0, topCount).reduce((a, b) => a + b, 0) / topCount;
          
          // Set speech threshold (ambient + 12dB)
          this.speechThreshold = this.ambientLevel * 4; // ~12dB
          
          console.log(`[Mic] Calibrated - ambient: ${this.ambientLevel.toFixed(1)}, threshold: ${this.speechThreshold.toFixed(1)}`);
          resolve();
        }
      };
      
      sample();
    });
  }
  
  // VAD loop
  private startVadLoop(): void {
    if (!this.isListening || !this.micAnalyzer) return;
    
    const checkVad = () => {
      if (!this.isListening) return;
      
      const currentLevel = this.getCurrentLevel();
      const isSpeaking = currentLevel > this.speechThreshold;
      
      // Update VAD state
      if (isSpeaking) {
        if (this.vadWindow === 0) {
          this.vadWindow = 1;
          this.vadStartTime = Date.now();
        } else if (this.vadWindow === 1) {
          const duration = Date.now() - this.vadStartTime;
          if (duration >= 120) { // 120ms sustained speech
            this.vadWindow = 2;
            this.onSpeechStart?.();
            console.log('[VAD] Speech started');
          }
        }
      } else {
        if (this.vadWindow > 0) {
          this.vadWindow = 0;
          this.onSpeechEnd?.();
          console.log('[VAD] Speech ended');
        }
      }
      
      this.onVadUpdate?.(isSpeaking, currentLevel);
      
      requestAnimationFrame(checkVad);
    };
    
    checkVad();
  }
  
  // Get current audio level
  private getCurrentLevel(): number {
    if (!this.micAnalyzer) return 0;
    
    const bufferLength = this.micAnalyzer.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    this.micAnalyzer.getByteFrequencyData(dataArray);
    
    // Calculate RMS level
    let sum = 0;
    for (let i = 0; i < bufferLength; i++) {
      sum += dataArray[i] * dataArray[i];
    }
    return Math.sqrt(sum / bufferLength);
  }
  
  // Get current VAD state
  getVadState(): { isSpeaking: boolean; level: number; ambient: number; threshold: number } {
    return {
      isSpeaking: this.vadWindow === 2,
      level: this.getCurrentLevel(),
      ambient: this.ambientLevel,
      threshold: this.speechThreshold
    };
  }
  
  // Stop microphone (only call during final teardown)
  stop(teardown = false): void {
    if (!teardown && process.env.NODE_ENV === 'development') {
      console.warn('[Mic] Attempted to stop mic before final teardown - blocking in dev mode');
      console.warn('[Mic] Call mic.stop(true) only during final teardown/navigation');
      return;
    }
    
    this.stopVadMonitoring();
    
    if (this.micSource) {
      this.micSource.disconnect();
      this.micSource = null;
    }
    
    if (this.micAnalyzer) {
      this.micAnalyzer.disconnect();
      this.micAnalyzer = null;
    }
    
    if (this.micGain) {
      this.micGain.disconnect();
      this.micGain = null;
    }
    
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    
    this.audioContext = null;
    console.log('[Mic] Stopped');
  }
}

// Export singleton instance
export const mic = new MicrophoneManager();


