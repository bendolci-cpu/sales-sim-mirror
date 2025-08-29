// Singleton audio manager for CloserCoach-style live voice UX
// End-to-end mono 24kHz, 16-bit PCM with singleton AudioContext and shared GainNode

class AudioManager {
  private static instance: AudioManager | null = null;
  
  // Singleton AudioContext for the whole session
  private audioContext: AudioContext | null = null;
  
  // Shared GainNode for TTS output
  private ttsGainNode: GainNode | null = null;
  
  // Device routing state
  private sinkIdSupported: boolean | null = null;
  private sinkIdErrorLogged = false;
  
  // TTS playback state
  private currentTtsSource: AudioBufferSourceNode | null = null;
  private currentTtsBuffer: AudioBuffer | null = null;
  
  // Audio format constants
  private readonly SAMPLE_RATE = 24000; // 24kHz mono
  private readonly CHANNEL_COUNT = 1; // Mono
  private readonly BIT_DEPTH = 16; // 16-bit
  
  private constructor() {}
  
  static getInstance(): AudioManager {
    if (!AudioManager.instance) {
      AudioManager.instance = new AudioManager();
    }
    return AudioManager.instance;
  }
  
  // Initialize singleton AudioContext
  async initializeAudioContext(): Promise<AudioContext> {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: this.SAMPLE_RATE,
        latencyHint: 'interactive'
      });
      
      // Create shared GainNode for TTS output
      this.ttsGainNode = this.audioContext.createGain();
      this.ttsGainNode.gain.value = 0.7; // Default volume
      this.ttsGainNode.connect(this.audioContext.destination);
      
      console.log(`[Audio] Initialized AudioContext at ${this.SAMPLE_RATE}Hz mono`);
    }
    
    // Resume AudioContext on first user gesture
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
      console.log("[Audio] AudioContext resumed");
    }
    
    return this.audioContext;
  }
  
  // Get the singleton AudioContext
  getAudioContext(): AudioContext | null {
    return this.audioContext;
  }
  
  // Get the shared TTS GainNode
  getTtsGainNode(): GainNode | null {
    return this.ttsGainNode;
  }
  
  // Check if setSinkId is supported (test once)
  private checkSinkIdSupport(): boolean {
    if (this.sinkIdSupported !== null) {
      return this.sinkIdSupported;
    }
    
    const testAudio = document.createElement('audio');
    this.sinkIdSupported = 'setSinkId' in testAudio;
    
    if (!this.sinkIdSupported && !this.sinkIdErrorLogged) {
      console.log('[Audio] setSinkId not supported in this browser');
      this.sinkIdErrorLogged = true;
    }
    
    return this.sinkIdSupported;
  }
  
  // Guard setSinkId - only call if supported and valid deviceId
  async routeAudioToDevice(audioElement: HTMLAudioElement, deviceId?: string): Promise<boolean> {
    if (!this.checkSinkIdSupport()) {
      return false;
    }
    
    if (!deviceId || deviceId === 'default' || deviceId === 'communications') {
      return false; // Skip routing for generic devices
    }
    
    try {
      const devices = await this.enumerateOutputDevices();
      const deviceExists = devices.some(d => d.deviceId === deviceId);
      
      if (!deviceExists) {
        console.log(`[Audio] Device ${deviceId} not found, using default speakers`);
        return false;
      }
      
      await (audioElement as any).setSinkId(deviceId);
      console.log(`[Audio] Successfully routed to device: ${deviceId}`);
      return true;
    } catch (error: any) {
      // Log error once and fall back to default speakers
      if (!this.sinkIdErrorLogged) {
        console.log(`[Audio] Device routing failed, using default speakers: ${error.message}`);
        this.sinkIdErrorLogged = true;
      }
      return false;
    }
  }
  
  // Enumerate input devices
  async enumerateInputDevices(): Promise<MediaDeviceInfo[]> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter(device => device.kind === 'audioinput');
    } catch (error) {
      console.warn('[Audio] Failed to enumerate input devices:', error);
      return [];
    }
  }
  
  // Enumerate output devices
  async enumerateOutputDevices(): Promise<MediaDeviceInfo[]> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter(device => device.kind === 'audiooutput');
    } catch (error) {
      console.warn('[Audio] Failed to enumerate output devices:', error);
      return [];
    }
  }
  
  // Create audio element with device routing
  async createAudioElement(id: string, options?: {
    routeToDevice?: string;
    volume?: number;
  }): Promise<HTMLAudioElement> {
    const audioEl = document.createElement('audio');
    audioEl.id = id;
    audioEl.controls = false;
    audioEl.autoplay = false;
    audioEl.preload = 'none';
    
    if (options?.volume !== undefined) {
      audioEl.volume = Math.max(0, Math.min(1, options.volume));
    }
    
    document.body.appendChild(audioEl);
    
    // Route to specific device if requested
    if (options?.routeToDevice && options.routeToDevice !== 'none') {
      await this.routeAudioToDevice(audioEl, options.routeToDevice);
    }
    
    return audioEl;
  }
  
  // Test microphone levels
  async testMicrophoneLevels(stream: MediaStream): Promise<number> {
    if (!this.audioContext) {
      await this.initializeAudioContext();
    }
    
    const audioContext = this.audioContext!;
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    
    source.connect(analyser);
    
    // Sample for 1 second
    const startTime = Date.now();
    let maxLevel = 0;
    
    return new Promise((resolve) => {
      const checkLevel = () => {
        analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
        maxLevel = Math.max(maxLevel, average);
        
        if (Date.now() - startTime < 1000) {
          requestAnimationFrame(checkLevel);
        } else {
          source.disconnect();
          analyser.disconnect();
          resolve(maxLevel);
        }
      };
      
      checkLevel();
    });
  }
  
  // Cancelable TTS playback using AudioBufferSourceNode
  async playTtsAudio(audioUrl: string, options?: {
    volume?: number;
    routeToDevice?: string;
    onComplete?: () => void;
  }): Promise<{ cancel: () => void }> {
    if (!this.audioContext || !this.ttsGainNode) {
      throw new Error('AudioContext not initialized');
    }
    
    // Cancel any existing TTS
    this.cancelTtsPlayback();
    
    try {
      // Fetch and decode audio
      const response = await fetch(audioUrl);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
      
      // Create source node - fixed method name
      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      
      // Set volume
      if (options?.volume !== undefined) {
        this.ttsGainNode.gain.value = Math.max(0, Math.min(1, options.volume));
      }
      
      // Connect through shared GainNode
      source.connect(this.ttsGainNode);
      
      // Store current TTS state
      this.currentTtsSource = source;
      this.currentTtsBuffer = audioBuffer;
      
      // Start playback
      source.start(0);
      console.log(`[TTS] Started playback: ${audioBuffer.duration.toFixed(2)}s`);
      
      // Handle completion
      source.onended = () => {
        if (this.currentTtsSource === source) {
          this.currentTtsSource = null;
          this.currentTtsBuffer = null;
          console.log('[TTS] Playback completed');
          // Call the completion callback if provided
          options?.onComplete?.();
        }
      };
      
      return {
        cancel: () => {
          this.cancelTtsPlayback();
        }
      };
    } catch (error) {
      console.error('[TTS] Failed to play audio:', error);
      throw error;
    }
  }
  
  // Cancel current TTS playback
  cancelTtsPlayback(): void {
    if (this.currentTtsSource) {
      try {
        this.currentTtsSource.stop();
        this.currentTtsSource.disconnect();
        console.log('[TTS] Playback canceled');
      } catch (error) {
        console.warn('[TTS] Error canceling playback:', error);
      }
      this.currentTtsSource = null;
      this.currentTtsBuffer = null;
    }
  }
  
  // Create analyzer for AI audio monitoring
  createAiAnalyzer(): AnalyserNode | null {
    if (!this.audioContext) return null;
    
    const analyser = this.audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    
    // Connect to TTS GainNode to monitor AI audio
    if (this.ttsGainNode) {
      this.ttsGainNode.connect(analyser);
    }
    
    return analyser;
  }
  
  // Get audio format info
  getAudioFormat() {
    return {
      sampleRate: this.SAMPLE_RATE,
      channelCount: this.CHANNEL_COUNT,
      bitDepth: this.BIT_DEPTH
    };
  }
  
  // Clean up all resources
  cleanup(): void {
    this.cancelTtsPlayback();
    
    if (this.ttsGainNode) {
      this.ttsGainNode.disconnect();
      this.ttsGainNode = null;
    }
    
    if (this.audioContext) {
      try {
        if (this.audioContext.state !== 'closed') {
          this.audioContext.close();
        }
      } catch (error) {
        console.warn('[Audio] Failed to close AudioContext:', error);
      }
      this.audioContext = null;
    }
    
    // Reset state
    this.sinkIdSupported = null;
    this.sinkIdErrorLogged = false;
    
    console.log('[Audio] Cleanup completed');
  }
}

// Export singleton instance
export const audioManager = AudioManager.getInstance();

// Export types for components
export type AudioDevice = MediaDeviceInfo;
export type AudioOutputDevice = MediaDeviceInfo;
