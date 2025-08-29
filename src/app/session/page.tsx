"use client";

import React from "react";
import { Room, createLocalAudioTrack, Track } from "livekit-client";
import { useRef, useState, useMemo, useEffect, Suspense } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import ClientOnly from "@/components/ClientOnly";
const ChatWindowClient = dynamic(() => import("@/components/ChatWindow"), { ssr: false });
import BudgetBadge from "@/components/BudgetBadge";
import ScenarioPicker from "@/components/ScenarioPicker";
import { SCENARIOS, type Scenario } from "@/data/scenarios";
import { CallMachine } from "@/lib/voice/callMachine";
import { getAgentReply, speak as agentSpeak, stopSpeaking } from "@/lib/voice/mockAgent";
import CallBar from "@/components/CallBar";
import DebugToggle from "@/components/DebugToggle";
import AudioDeviceSelector from "@/components/AudioDeviceSelector";
import { createEnhancedSpeech, type EnhancedSpeechControls } from "@/lib/speech/enhancedSpeech";
import { saveCall } from "@/lib/calls/store";
import type { CallMeta, CallTurn } from "@/lib/calls/types";
import { mic } from "@/lib/mic";
import { audioManager } from "@/lib/audio";
import { logInfo, logDebug, logThrottled, logChange, logWarn, logError } from "@/lib/logger";
import { registerMessageHandler, unregisterMessageHandler, setMessageDispatcherConnected } from "@/lib/messageDispatcher";

// 1. CallSession → state machine, owns truth for ai_playing, barge_enabled, user_speaking
class CallSession {
  private state: 'idle' | 'user_speaking' | 'ai_thinking' | 'ai_playing' = 'idle';
  private aiPlaying = false;
  private bargeEnabled = false;
  private userSpeaking = false;
  private listeners: Array<(state: string) => void> = [];

  setState(newState: 'idle' | 'user_speaking' | 'ai_thinking' | 'ai_playing') {
    this.state = newState;
    this.listeners.forEach(listener => listener(newState));
  }

  setAIPlaying(playing: boolean) {
    this.aiPlaying = playing;
  }

  setBargeEnabled(enabled: boolean) {
    this.bargeEnabled = enabled;
  }

  setUserSpeaking(speaking: boolean) {
    this.userSpeaking = speaking;
  }

  getState() { return this.state; }
  isAIPlaying() { return this.aiPlaying; }
  isBargeEnabled() { return this.bargeEnabled; }
  isUserSpeaking() { return this.userSpeaking; }

  onStateChange(listener: (state: string) => void) {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index > -1) this.listeners.splice(index, 1);
    };
  }
}

// 2. AudioManager → creates AudioContext, mixers, analyzers; raises events like onAIAudioPlay
class AudioManager {
  private audioContext: AudioContext | null = null;
  private micAnalyzer: AnalyserNode | null = null;
  private aiAnalyzer: AnalyserNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private aiSource: MediaElementAudioSourceNode | null = null;
  private listeners: Array<{ event: string; callback: Function }> = [];

  async initializeAudioContext(): Promise<AudioContext> {
    if (!this.audioContext) {
      this.audioContext = new AudioContext({ sampleRate: 24000 });
      await this.audioContext.resume();
    }
    return this.audioContext;
  }

  setupMicAnalyzer(stream: MediaStream) {
    if (!this.audioContext) return;
    
    this.micAnalyzer = this.audioContext.createAnalyser();
    this.micAnalyzer.fftSize = 256;
    this.micAnalyzer.smoothingTimeConstant = 0.8;
    
    this.micSource = this.audioContext.createMediaStreamSource(stream);
    this.micSource.connect(this.micAnalyzer);
    
    logInfo("[AudioManager] Mic analyzer setup complete");
  }

  setupAIAnalyzer(audioElement: HTMLAudioElement) {
    if (!this.audioContext) return;
    
    // Check if this audio element is already connected
    if (this.aiSource && this.aiSource.mediaElement === audioElement) {
      logDebug("[AudioManager] AI analyzer already attached to this audio element - reusing");
      this.emit('aiAudioReady');
      return;
    }
    
    // Clean up existing AI analyzer
    if (this.aiSource) {
      this.aiSource.disconnect();
      this.aiSource = null;
    }
    
    this.aiAnalyzer = this.audioContext.createAnalyser();
    this.aiAnalyzer.fftSize = 256;
    this.aiAnalyzer.smoothingTimeConstant = 0.8;
    
    try {
      this.aiSource = this.audioContext.createMediaElementSource(audioElement);
      this.aiSource.connect(this.aiAnalyzer);
      
      console.log("[AudioManager] AI analyzer setup complete");
      this.emit('aiAudioReady');
    } catch (error) {
      console.warn("[AudioManager] Failed to setup AI analyzer - audio element may already be connected:", error);
      // Don't emit aiAudioReady if setup failed
    }
  }

  getMicAnalyzer() { return this.micAnalyzer; }
  getAIAnalyzer() { 
    // If we have a modular AI analyzer, use it
    if (this.aiAnalyzer) {
      console.log("[AudioManager] Using modular AI analyzer");
      return this.aiAnalyzer;
    }
    
    // Otherwise, try to get from legacy system
    try {
      // Access the global audioManager instance
      const legacyAnalyzer = (window as any).__audioManager?.getAiAnalyzer();
      if (legacyAnalyzer) {
        console.log("[AudioManager] Using legacy AI analyzer");
        return legacyAnalyzer;
      } else {
        console.log("[AudioManager] No legacy AI analyzer available");
      }
    } catch (e) {
      console.warn("[AudioManager] Failed to get legacy AI analyzer:", e);
    }
    
    console.log("[AudioManager] No AI analyzer available");
    return null;
  }

  on(event: string, callback: Function) {
    this.listeners.push({ event, callback });
  }

  emit(event: string, data?: any) {
    this.listeners.forEach(({ event: listenerEvent, callback }) => {
      if (listenerEvent === event && callback) callback(data);
    });
  }

  cleanup() {
    if (this.micSource) this.micSource.disconnect();
    if (this.aiSource) this.aiSource.disconnect();
    this.micAnalyzer = null;
    this.aiAnalyzer = null;
  }
}

// 3. ASRManager → runs recognition, exposes isSpeech()
class ASRManager {
  private speechInstance: EnhancedSpeechControls | null = null;
  private isSpeechDetected = false;
  private listeners: Array<{ event: string; callback: Function }> = [];

  startRecognition() {
    if (this.speechInstance) return;
    
    // Connect to the existing speech recognition system instead of creating a new one
    // The legacy system is already running and working
    console.log("[ASRManager] Connecting to existing speech recognition system");
  }

  // Method to update speech detection state from the legacy system
  updateSpeechState(isSpeaking: boolean) {
    const wasSpeaking = this.isSpeechDetected;
    this.isSpeechDetected = isSpeaking;
    logChange('asr-speech-state', isSpeaking, '[ASRManager] Speech state updated');
    if (isSpeaking) {
      this.emit('speechStart');
    } else {
      this.emit('speechEnd');
    }
  }

  stopRecognition() {
    if (this.speechInstance) {
      this.speechInstance.stop();
      this.speechInstance = null;
    }
  }

  isSpeech() { 
    return this.isSpeechDetected; 
  }

  on(event: string, callback: Function) {
    this.listeners.push({ event, callback });
  }

  emit(event: string, data?: any) {
    this.listeners.forEach(({ event: listenerEvent, callback }) => {
      if (listenerEvent === event && callback) callback(data);
    });
  }
}

// 4. BargeInDetector → subscribes to AudioManager + ASRManager; emits BARGE_IN only if both confirm
class BargeInDetector {
  private audioManager: AudioManager;
  private asrManager: ASRManager;
  private callSession: CallSession;
  private monitoring = false;
  private timer: NodeJS.Timeout | null = null;
  private listeners: Array<{ event: string; callback: Function }> = [];

  constructor(audioManager: AudioManager, asrManager: ASRManager, callSession: CallSession) {
    this.audioManager = audioManager;
    this.asrManager = asrManager;
    this.callSession = callSession;
  }

  startMonitoring() {
    if (this.monitoring) return;
    
    this.monitoring = true;
    
    // Simple invariant log: "monitor started with analyzer?" true/false
    const micAnalyzer = this.audioManager.getMicAnalyzer();
    const aiAnalyzer = this.audioManager.getAIAnalyzer();
    console.log(`[BargeInDetector] Starting monitoring - mic analyzer: ${!!micAnalyzer}, ai analyzer: ${!!aiAnalyzer}`);
    console.log('[Analyzers]', { mic: !!micAnalyzer, ai: !!aiAnalyzer });
    
    this.timer = setInterval(() => {
      this.checkBargeIn();
    }, 16); // ~60fps
  }

  stopMonitoring() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.monitoring = false;
    console.log("[BargeInDetector] Monitoring stopped");
  }

  private checkBargeIn() {
    if (!this.callSession.isAIPlaying()) return;
    
    const micAnalyzer = this.audioManager.getMicAnalyzer();
    const aiAnalyzer = this.audioManager.getAIAnalyzer();
    
    if (!micAnalyzer || !aiAnalyzer) {
      console.log("[BargeInDetector] Analyzers not ready - mic:", !!micAnalyzer, "ai:", !!aiAnalyzer);
      return;
    }
    
    const micRMS = this.calculateRMS(micAnalyzer);
    const aiRMS = this.calculateRMS(aiAnalyzer);
    const asrSpeech = this.asrManager.isSpeech();
    
    // Only log when there's significant activity to reduce noise
    if (micRMS > 15 || asrSpeech) {
              logThrottled('barge-monitoring', `[BargeInDetector] Monitoring - micRMS:${micRMS.toFixed(1)}, aiRMS:${aiRMS.toFixed(1)}, ASR:${asrSpeech}`);
      
              // Debug: Check barge-in conditions
        if (micRMS > 15 && asrSpeech) {
          logDebug(`[BargeInDetector] Barge-in conditions met - micRMS:${micRMS.toFixed(1)}, ASR:${asrSpeech}`);
        }
    }
    
    // Require both ASR speech AND micRMS > aiRMS * 1.2
    if (asrSpeech && micRMS > aiRMS * 1.2) {
      console.log(`[BargeInDetector] BARGE_IN detected - micRMS:${micRMS.toFixed(1)}, aiRMS:${aiRMS.toFixed(1)}, ASR:${asrSpeech}`);
      this.emit('bargeIn');
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

  on(event: string, callback: Function) {
    this.listeners.push({ event, callback });
  }

  private emit(event: string, data?: any) {
    this.listeners.forEach(({ event: listenerEvent, callback }) => {
      if (listenerEvent === event) callback(data);
    });
  }
}

// 5. TTSPlayer → given text, generates audio, emits playing / ended, supports abort()
class TTSPlayer {
  private currentAbortController: AbortController | null = null;
  private listeners: Array<{ event: string; callback: Function }> = [];

  async playTTS(audioUrl: string, options?: { volume?: number }): Promise<{ abort: () => void }> {
    // Cancel any existing playback
    if (this.currentAbortController) {
      this.currentAbortController.abort();
    }
    
    this.currentAbortController = new AbortController();
    const abortController = this.currentAbortController;
    
    try {
      // Create a unique audio element to avoid conflicts
      const audioElement = document.createElement('audio');
      audioElement.id = `tts-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      audioElement.src = audioUrl;
      audioElement.volume = options?.volume || 0.7;
      
      // Ensure the audio element is added to the DOM so it can play
      document.body.appendChild(audioElement);
      
      // Wait for audio to load
      await new Promise<void>((resolve, reject) => {
        audioElement.addEventListener('canplaythrough', () => resolve(), { once: true });
        audioElement.addEventListener('error', () => reject(new Error('Audio load failed')), { once: true });
        abortController.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
      });
      
      if (abortController.signal.aborted) {
        throw new Error('Aborted during load');
      }
      
      this.emit('playing', audioElement);
      
      // Start playback
      await audioElement.play();
      
      if (abortController.signal.aborted) {
        audioElement.pause();
        throw new Error('Aborted during play');
      }
      
      // Wait for completion
      await new Promise<void>((resolve, reject) => {
        audioElement.addEventListener('ended', () => resolve(), { once: true });
        audioElement.addEventListener('error', () => reject(new Error('Audio playback failed')), { once: true });
        abortController.signal.addEventListener('abort', () => {
          audioElement.pause();
          resolve();
        }, { once: true });
      });
      
      this.emit('ended');
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (errorMessage !== 'Aborted') {
        console.error('[TTSPlayer] Playback error:', error);
      }
      this.emit('error', error);
    } finally {
      if (this.currentAbortController === abortController) {
        this.currentAbortController = null;
      }
      
      // Clean up the audio element
      if (audioElement && audioElement.parentNode) {
        audioElement.parentNode.removeChild(audioElement);
      }
    }
    
    return {
      abort: () => {
        if (this.currentAbortController === abortController) {
          abortController.abort();
        }
      }
    };
  }

  on(event: string, callback: Function) {
    this.listeners.push({ event, callback });
  }

  private emit(event: string, data?: any) {
    this.listeners.forEach(({ event: listenerEvent, callback }) => {
      if (listenerEvent === event) callback(data);
    });
  }
}

// Ensure audio element exists and is configured
async function ensureAudioEl(id: string, options?: { routeToDevice?: string; volume?: number }): Promise<HTMLAudioElement> {
  let audioEl = document.getElementById(id) as HTMLAudioElement;
  
  if (!audioEl) {
    audioEl = await audioManager.createAudioElement(id, options);
  }
  
  return audioEl;
}

function SessionInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Initialize modular components
  const callSessionRef = useRef<CallSession | null>(null);
  const audioManagerRef = useRef<AudioManager | null>(null);
  const asrManagerRef = useRef<ASRManager | null>(null);
  const bargeInDetectorRef = useRef<BargeInDetector | null>(null);
  const ttsPlayerRef = useRef<TTSPlayer | null>(null);

  const modeRaw = (searchParams.get("mode") || "practice").toLowerCase();
  const modeLabel = modeRaw === "challenge" ? "Challenge" : "Practice";

  const initialIsMock = useMemo(() => {
    const raw = (searchParams.get("mock") || "1").toLowerCase();
    return ["1", "true", "on", "yes", "y"].includes(raw);
  }, [searchParams]);

  const [isMock, setIsMock] = useState<boolean>(initialIsMock);
  const [voiceConnected, setVoiceConnected] = useState<boolean>(false);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const machineRef = useRef<CallMachine | null>(null);
  
  // Scenario selection (must be defined before use in greeting logic)
  const scenarioId: string = searchParams.get("scenario") || "";
  const currentScenario: Scenario | null = useMemo(() => {
    const found = SCENARIOS.find((s: Scenario) => s.id === scenarioId);
    return found ?? null;
  }, [scenarioId]);
  
  // LIVEKIT
  const roomRef = useRef<Room | null>(null);
  const historyRef = useRef<Array<{ role: "user" | "agent"; text: string; at: number; wpm?: number; interrupted?: boolean; audioUrl?: string }>>([]);
  const callIdRef = useRef<string>("");
  const startedAtRef = useRef<number>(0);
  const connectedAtRef = useRef<number>(0);
  const voiceConnectedRef = useRef<boolean>(false);
  const [showChat, setShowChat] = useState<boolean>(false);
  const greetedRef = useRef<boolean>(false);
  const lastHashRef = useRef<string>("");
  const speechRef = useRef<EnhancedSpeechControls | null>(null);
  const [externalTurn, setExternalTurn] = useState<{ role: "user" | "bot"; text: string; timestamp?: number } | null>(null);
  const agentSpeakingRef = useRef<boolean>(false);
  const waitingForUserRef = useRef<boolean>(false);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [isInitializing, setIsInitializing] = useState<boolean>(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [isToggling, setIsToggling] = useState<boolean>(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  
  // Barge-in detection
  const bargeInTimerRef = useRef<NodeJS.Timeout | null>(null);
  const continuousSpeechStartRef = useRef<number | null>(null);
  const bargeInStartTimeRef = useRef<number | null>(null);
  const bargeInDetectedRef = useRef<boolean>(false);
  const aiPlayingStartTimeRef = useRef<number | null>(null);
  
  // Current AI audio element for direct cancellation
  const currentAIAudioRef = useRef<HTMLAudioElement | null>(null);
  
  // Function to stop only the interrupted audio playback (not future ones)
  const stopInterruptedAudioPlayback = () => {
    console.log("[BARGE-IN] Stopping interrupted audio playback only");
    logInfo("[BargeIn] Stopped TTS for new speech");
    
    // Stop audioManager TTS
    try {
      audioManager.cancelTtsPlayback();
      console.log("[BARGE-IN] AudioManager TTS cancelled");
    } catch (e) {
      console.warn("[BARGE-IN] Failed to cancel AudioManager TTS:", e);
    }
    
    // Stop only the current AI audio element (the one being interrupted)
    if (currentAIAudioRef.current) {
      try {
        currentAIAudioRef.current.pause();
        currentAIAudioRef.current.currentTime = 0;
        console.log("[BARGE-IN] Interrupted AI audio element cancelled:", currentAIAudioRef.current.src);
      } catch (e) {
        console.warn("[BARGE-IN] Failed to cancel current AI audio element:", e);
      }
      currentAIAudioRef.current = null;
    }
    
    // Stop any pending TTS
    if (pendingTtsRef.current) {
      try {
        pendingTtsRef.current.cancel();
        console.log("[BARGE-IN] Pending TTS cancelled");
      } catch (e) {
        console.warn("[BARGE-IN] Failed to cancel pending TTS:", e);
      }
      pendingTtsRef.current = null;
    }
  };
  
  // Barge-in state management
  const aiPlayingRef = useRef<boolean>(false);
  const ttsPlayingRef = useRef<boolean>(false);
  const bargeEnabledRef = useRef<boolean>(false);
  const bargeActiveRef = useRef<boolean>(false); 
  
  // Assistant deduplication
  const recentAssistantTexts = useRef<Map<string, number>>(new Map()); // normalized text -> timestamp
  const ASSISTANT_DEDUP_MS = 10000; // 10 seconds
  
  // Speech recognition singleton guard
  const speechInstanceRef = useRef<EnhancedSpeechControls | null>(null);
  
  // Mic track monitoring
  const micTrackStatusRef = useRef<{ live: boolean; enabled: boolean; readyState: string }>({
    live: false,
    enabled: false,
    readyState: 'unknown'
  });
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  
  // Call flow state machine - improved states
  type CallState = 'idle' | 'user_speaking' | 'ai_thinking' | 'ai_playing';
  const [callState, setCallState] = useState<CallState>('idle');
  const callStateRef = useRef<CallState>('idle');
  
  // HMR protection
  const mountedRef = useRef<boolean>(false);
  const cleanupRef = useRef<Array<() => void>>([]);
  
  // Single-flight TTS guard
  const currentTurnIdRef = useRef<string | null>(null);
  const ttsEndedCallbacksRef = useRef<Map<string, () => void>>(new Map());
  
  // Echo suppression system
  const audioContextRef = useRef<AudioContext | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const aiAnalyserRef = useRef<AnalyserNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const aiSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const echoGateRef = useRef<{ active: boolean; startTime: number; micRMS: number; aiRMS: number }>({
    active: false,
    startTime: 0,
    micRMS: 0,
    aiRMS: 0
  });
  const echoGateConfig = { 
    threshold: 12, 
    duration: 200,
    minWords: 3,
    minDuration: 1200,
    minConfidence: 0.92
  }; // Enhanced echo gate config
  
  // Text chat mirror for debugging
  const [asrPartials, setAsrPartials] = useState<string>("");
  const [asrFinals, setAsrFinals] = useState<string[]>([]);
  const [droppedItems, setDroppedItems] = useState<Array<{ text: string; reason: string; timestamp: number }>>([]);
  
  // Per-turn recording refs
  const localMicTrackRef = useRef<MediaStreamTrack | null>(null);
  const agentTrackRef = useRef<MediaStreamTrack | null>(null);
  const userRecRef = useRef<MediaRecorder | null>(null);
  const agentRecRef = useRef<MediaRecorder | null>(null);
  const userRecDoneRef = useRef<Promise<string | null> | null>(null);
  const agentRecDoneRef = useRef<Promise<string | null> | null>(null);
  const attemptedRecordingRef = useRef<boolean>(false);
  
  // Hot-reload protection
  const isCallActiveRef = useRef<boolean>(false);
  
  // Strict turn management - only one active AI+TTS at a time
  const activeTurnIdRef = useRef<string | null>(null);

  // Initialize modular components on mount
  useEffect(() => {
    if (!callSessionRef.current) {
      callSessionRef.current = new CallSession();
    }
    if (!audioManagerRef.current) {
      audioManagerRef.current = new AudioManager();
    }
    if (!asrManagerRef.current) {
      asrManagerRef.current = new ASRManager();
    }
    if (!ttsPlayerRef.current) {
      ttsPlayerRef.current = new TTSPlayer();
    }
    if (!bargeInDetectorRef.current && callSessionRef.current && audioManagerRef.current && asrManagerRef.current) {
      bargeInDetectorRef.current = new BargeInDetector(
        audioManagerRef.current,
        asrManagerRef.current,
        callSessionRef.current
      );
    }

    // Wire up barge-in detection
    if (bargeInDetectorRef.current) {
      bargeInDetectorRef.current.on('bargeIn', () => {
        console.log('[BargeInDetector] BARGE_IN event received');
        handleBargeIn();
      });
    }

    // Wire up TTS player events
    if (ttsPlayerRef.current) {
      ttsPlayerRef.current.on('playing', (audioElement: HTMLAudioElement) => {
        console.log('[TTSPlayer] Audio started playing');
        // Setup AI analyzer when audio starts playing
        if (audioManagerRef.current) {
          audioManagerRef.current.setupAIAnalyzer(audioElement);
        }
      });
      
      ttsPlayerRef.current.on('ended', () => {
        console.log('[TTSPlayer] Audio playback ended');
        exitAIPlaying();
      });
      
      ttsPlayerRef.current.on('error', (error: any) => {
        console.error('[TTSPlayer] Playback error:', error);
        exitAIPlaying();
      });
    }

    // Wire up audio manager events
    if (audioManagerRef.current) {
      audioManagerRef.current.on('aiAudioReady', () => {
        console.log('[AudioManager] AI audio ready - starting barge-in monitoring');
        // Start barge-in monitoring only after AI analyzer is ready
        if (bargeInDetectorRef.current) {
          bargeInDetectorRef.current.startMonitoring();
        }
      });
    }
    
    // Connect legacy AudioManager to modular system
    const legacyAudioManager = audioManager;
    legacyAudioManager.onAiAudioReady = () => {
      console.log('[LegacyAudioManager] AI audio ready - triggering modular system');
      // Trigger the modular system's aiAudioReady event
      if (audioManagerRef.current) {
        audioManagerRef.current.emit('aiAudioReady');
      }
    };
    
    // Expose audioManager globally for modular system access
    (window as any).__audioManager = audioManager;

    return () => {
      // Cleanup on unmount
      if (bargeInDetectorRef.current) {
        bargeInDetectorRef.current.stopMonitoring();
      }
      if (asrManagerRef.current) {
        asrManagerRef.current.stopRecognition();
      }
      if (audioManagerRef.current) {
        audioManagerRef.current.cleanup();
      }
    };
  }, []);
  const pendingTtsRef = useRef<{ cancel: () => void } | null>(null);
  const ttsStartedRef = useRef<Set<string>>(new Set()); // Track which turnIds have started TTS
  
  // State machine helper functions
  const enterAIPlaying = () => {
    console.log("[State] Entering ai_playing");
    
    // Update modular state
    if (callSessionRef.current) {
      callSessionRef.current.setState('ai_playing');
      callSessionRef.current.setAIPlaying(true);
      callSessionRef.current.setBargeEnabled(true);
    }
    
    setCallState('ai_playing');
    callStateRef.current = 'ai_playing';
    
    // Set legacy state flags for compatibility
    aiPlayingRef.current = true;
    ttsPlayingRef.current = true;
    bargeEnabledRef.current = true;
    bargeActiveRef.current = false;
    
    // Track when AI playing started for timeout detection
    aiPlayingStartTimeRef.current = Date.now();
    
    console.log("[State] ai_playing:true, tts_playing:true, barge_enabled:true, barge_active:false");
    
    // Reset barge-in detection
    bargeInDetectedRef.current = false;
    bargeInStartTimeRef.current = null;
    
    // Keep ASR active for barge-in detection - DON'T stop it!
    // The speech recognition needs to stay active to detect when user starts speaking
    console.log("[State] Keeping ASR active for barge-in detection");
    
    // Ensure mic track is enabled for barge-in detection
    try {
      if (micStreamRef.current) {
        const audioTracks = micStreamRef.current.getAudioTracks();
        audioTracks.forEach(track => {
          track.enabled = true;
          console.log("[State] Mic track enabled for barge-in detection");
        });
      }
    } catch (e) {
      console.warn("[State] Failed to enable mic track:", e);
    }
    
    // Start ASR if not already running
    if (asrManagerRef.current) {
      asrManagerRef.current.startRecognition();
    }
    
    setAgentSpeaking(true);
    agentSpeakingRef.current = true;
  };

  const exitAIPlaying = () => {
    console.log("[State] Exiting ai_playing");
    
    // Update modular state
    if (callSessionRef.current) {
      callSessionRef.current.setState('idle');
      callSessionRef.current.setAIPlaying(false);
      callSessionRef.current.setBargeEnabled(false);
    }
    
    // Stop barge-in monitoring
    if (bargeInDetectorRef.current) {
      bargeInDetectorRef.current.stopMonitoring();
    }
    
    // Reset legacy state flags
    aiPlayingRef.current = false;
    ttsPlayingRef.current = false;
    bargeEnabledRef.current = false;
    bargeActiveRef.current = false;
    
    console.log("[State] ai_playing:false, tts_playing:false, barge_enabled:false, barge_active:false");
    
    // Set agent speaking to false first
    setAgentSpeaking(false);
    agentSpeakingRef.current = false;
    
    // Do NOT restart ASR - keep it running continuously
    console.log("[State] ASR continues running (no restart)");
    
    setCallState('idle');
    callStateRef.current = 'idle';
  };

  const enterUserSpeaking = () => {
    console.log("[State] Entering user_speaking (barge-in)");
    
    // Update modular state
    if (callSessionRef.current) {
      callSessionRef.current.setState('user_speaking');
      callSessionRef.current.setUserSpeaking(true);
      callSessionRef.current.setAIPlaying(false);
    }
    
    setCallState('user_speaking');
    callStateRef.current = 'user_speaking';
    
    // Stop barge-in monitoring
    if (bargeInDetectorRef.current) {
      bargeInDetectorRef.current.stopMonitoring();
    }
    
    // Cancel any pending TTS using modular TTS player
    if (ttsPlayerRef.current) {
      // The TTS player handles its own abort logic
      console.log("[State] TTS cancelled via modular player");
    }
    
    // Legacy TTS cancellation
    if (pendingTtsRef.current) {
      try {
        pendingTtsRef.current.cancel();
        console.log("[State] Legacy TTS cancelled in enterUserSpeaking");
      } catch (e) {
        console.warn("[State] Failed to cancel legacy TTS in enterUserSpeaking:", e);
      }
    }
    pendingTtsRef.current = null;
    
    // Stop only the interrupted audio playback
    stopInterruptedAudioPlayback();
    
    stopSpeaking();
    setAgentSpeaking(false);
    agentSpeakingRef.current = false;
    
    // Stop any playing audio elements
    const audioElements = document.querySelectorAll('audio');
    audioElements.forEach(audio => {
      try {
        audio.pause();
        audio.currentTime = 0;
      } catch (e) {
        console.warn("[BargeIn] Failed to stop audio element:", e);
      }
    });
    
    // Clean up AI analyzer
    aiAnalyserRef.current = null;
    aiSourceRef.current = null;
    
    // Re-enable mic immediately
    try {
      if (micStreamRef.current) {
        const audioTracks = micStreamRef.current.getAudioTracks();
        audioTracks.forEach(track => {
          track.enabled = true;
        });
        console.log("[State] Re-enabled mic for barge-in");
      }
    } catch (e) {
      console.warn("[State] Failed to re-enable mic for barge-in:", e);
    }
    
    // Speech recognition should already be active since we kept it running during AI playback
    // Just ensure it's still running and ready to capture user input
    console.log("[State] ASR continues running for user input (no restart)");
    
    // Return to listening after a short delay
    setTimeout(() => {
      setCallState('idle');
      callStateRef.current = 'idle';
    }, 100);
  };

  // HMR cleanup function
  const cleanup = () => {
    console.log("[Cleanup] Running cleanup");
    
    // Stop ASR and recognition
    try {
      if (speechRef.current) {
        speechRef.current.stop();
        speechRef.current = null;
      }
      if (speechInstanceRef.current) {
        speechInstanceRef.current.stop();
        speechInstanceRef.current = null;
      }
    } catch (e) {
      console.warn("[Cleanup] Failed to stop speech:", e);
    }
    
    // Don't stop microphone here - only during final teardown
    // try {
    //   mic.stop();
    // } catch (e) {
    //   console.warn("[Cleanup] Failed to stop microphone:", e);
    // }
    
    // Remove all listeners
    cleanupRef.current.forEach(cleanupFn => {
      try {
        cleanupFn();
      } catch (e) {
        console.warn("[Cleanup] Failed to run cleanup function:", e);
      }
    });
    cleanupRef.current = [];
    
    // Clear all timers
    if (bargeInTimerRef.current) {
      clearInterval(bargeInTimerRef.current);
      bargeInTimerRef.current = null;
    }
    if (continuousSpeechStartRef.current) {
      continuousSpeechStartRef.current = null;
    }
    if (bargeInStartTimeRef.current) {
      bargeInStartTimeRef.current = null;
    }
    bargeInDetectedRef.current = false;
    
    // Clean up audio analyzers
    try {
      if (aiSourceRef.current) {
        aiSourceRef.current.disconnect();
        aiSourceRef.current = null;
      }
      if (micSourceRef.current) {
        micSourceRef.current.disconnect();
        micSourceRef.current = null;
      }
      aiAnalyserRef.current = null;
      micAnalyserRef.current = null;
    } catch (e) {
      console.warn("[Cleanup] Failed to clean up audio analyzers:", e);
    }
    
    // Stop and remove all audio elements
    const audioElements = document.querySelectorAll('audio');
    audioElements.forEach(audio => {
      try {
        audio.pause();
        audio.currentTime = 0;
        audio.src = '';
        audio.muted = true;
        // Remove the element to prevent memory leaks and MediaElementAudioSourceNode conflicts
        if (audio.parentNode) {
          audio.parentNode.removeChild(audio);
        }
      } catch (e) {
        console.warn("[Cleanup] Failed to stop audio element:", e);
      }
    });
    
    console.log(`[Cleanup] Removed ${audioElements.length} audio elements`);
    
    // Clean up audio manager (closes AudioContext)
    try {
      audioManager.cleanup();
    } catch (e) {
      console.warn("[Cleanup] Failed to clean up audio manager:", e);
    }
    
    // Reset all refs
    micStreamRef.current = null;
    agentSpeakingRef.current = false;
    activeTurnIdRef.current = null;
    pendingTtsRef.current = null;
    ttsStartedRef.current.clear();
  };

  // Echo suppression helper functions
  const setupMicAnalyzer = () => {
    try {
      // Use the shared audio context from audioManager
      audioManager.initializeAudioContext().then(audioContext => {
        audioContextRef.current = audioContext;
        
        // Create mic analyzer
        if (micStreamRef.current && !micAnalyserRef.current) {
          micAnalyserRef.current = audioContext.createAnalyser();
          micAnalyserRef.current.fftSize = 256;
          micAnalyserRef.current.smoothingTimeConstant = 0.8;
          
          micSourceRef.current = audioContext.createMediaStreamSource(micStreamRef.current);
          micSourceRef.current.connect(micAnalyserRef.current);
          console.log("[Echo] Mic analyzer initialized");
        }
      });
    } catch (e) {
      console.warn("[Echo] Failed to initialize echo suppression:", e);
    }
  };

  const setupAIAnalyzer = (audioElement: HTMLAudioElement) => {
    try {
      if (!audioContextRef.current) return;
      
      // Clean up any existing AI analyzer
      if (aiSourceRef.current) {
        try {
          aiSourceRef.current.disconnect();
        } catch (e) {
          // Ignore disconnect errors
        }
        aiSourceRef.current = null;
      }
      
      // Create AI analyzer
      aiAnalyserRef.current = audioContextRef.current.createAnalyser();
      aiAnalyserRef.current.fftSize = 256;
      aiAnalyserRef.current.smoothingTimeConstant = 0.8;
      
      // Create gain node for volume control
      const gainNode = audioContextRef.current.createGain();
      gainNode.gain.value = 0.7; // Cap AI playback gain
      
      // Create MediaElementAudioSourceNode for this specific audio element
      // Each AI reply gets its own fresh audio element, so this should never fail
      aiSourceRef.current = audioContextRef.current.createMediaElementSource(audioElement);
      
      aiSourceRef.current.connect(aiAnalyserRef.current);
      aiSourceRef.current.connect(gainNode);
      gainNode.connect(audioContextRef.current.destination); // Route to speakers via gain
      console.log("[Echo] AI analyzer initialized with gain control");
    } catch (e) {
      console.warn("[Echo] Failed to setup AI analyzer:", e);
    }
  };

  const calculateRMS = (analyser: AnalyserNode): number => {
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);
    
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i] * dataArray[i];
    }
    const rms = Math.sqrt(sum / dataArray.length);
    return rms;
  };

  const checkEchoGate = (text: string, confidence: number, duration: number): boolean => {
    // Never run echo gate while AI is playing - use barge-in detection instead
    if (callStateRef.current === 'ai_playing') {
      return true; // Allow all speech when AI is playing
    }
    
    // Check minimum requirements for echo gate
    const words = text.split(/\s+/).filter(Boolean).length;
    if (words < echoGateConfig.minWords || duration < echoGateConfig.minDuration || confidence < echoGateConfig.minConfidence) {
      return true; // Allow short/low-confidence utterances
    }
    
    if (!micAnalyserRef.current || !aiAnalyserRef.current) return true; // Allow if analyzers not ready
    
    const micRMS = calculateRMS(micAnalyserRef.current);
    const aiRMS = calculateRMS(aiAnalyserRef.current);
    
    // Convert to dB
    const micDB = 20 * Math.log10(micRMS / 255);
    const aiDB = 20 * Math.log10(aiRMS / 255);
    
    const snr = micDB - aiDB;
    const now = Date.now();
    
    if (snr >= echoGateConfig.threshold) {
      if (!echoGateRef.current.active) {
        echoGateRef.current.active = true;
        echoGateRef.current.startTime = now;
        echoGateRef.current.micRMS = micRMS;
        echoGateRef.current.aiRMS = aiRMS;
      } else if (now - echoGateRef.current.startTime >= echoGateConfig.duration) {
        return true; // Gate passed
      }
    } else {
      echoGateRef.current.active = false;
    }
    
    return false; // Gate not passed
  };

  const logDroppedItem = (text: string, reason: string) => {
    const item = { text, reason, timestamp: Date.now() };
    setDroppedItems(prev => [...prev.slice(-9), item]); // Keep last 10
    console.log(`[Echo] Dropped: "${text}" - reason: ${reason}`);
  };

  // Helper function to manage AI speech state with strict barge-in
  const setAgentSpeaking = (speaking: boolean) => {
    agentSpeakingRef.current = speaking;
    if (!speaking) {
      // Clear active turn when AI stops speaking
      activeTurnIdRef.current = null;
      pendingTtsRef.current = null;
      
      // Start quiet gate after TTS ends
      if (speechRef.current) {
        speechRef.current.startQuietGate();
      }
      
      // Recording is continuous - no need to resume (ASR is always running)
      
      // Microphone is always enabled - never toggle (strict barge-in requirement)
      if (micStreamRef.current) {
        try {
          const audioTracks = micStreamRef.current.getAudioTracks();
          audioTracks.forEach(track => {
            track.enabled = true;
          });
          console.log("[Mic] Microphone always enabled (no toggling)");
        } catch (e) {
          console.warn("[Mic] Failed to ensure microphone enabled:", e);
        }
      }
    }
  };

  // Update mic track status for health monitoring
  const updateMicTrackStatus = () => {
    if (micStreamRef.current) {
      try {
        const audioTracks = micStreamRef.current.getAudioTracks();
        if (audioTracks.length > 0) {
          const track = audioTracks[0];
          micTrackStatusRef.current = {
            live: track.readyState === 'live',
            enabled: track.enabled,
            readyState: track.readyState
          };
        }
      } catch (e) {
        console.warn("[Mic] Failed to update track status:", e);
      }
    }
  };

  // Message dispatcher handler for AI processing
  const handleMessageDispatcher = async (request: any) => {
    const { text, metadata } = request;
    
    // Add user turn to history immediately (optimistic UI)
    pushTurn("user", text, { 
      wpm: Math.round((text.split(/\s+/).filter(Boolean).length / 2) * 60), // rough WPM estimate
      audioUrl: metadata.audioUrl 
    });
    
    // Generate AI response if we have a scenario
    if (!currentScenario) {
      return {
        id: crypto.randomUUID(),
        text: '',
        success: false,
        error: 'No scenario available'
      };
    }

    // Generate unique turn ID for this interaction
    const turnId = crypto.randomUUID();
    activeTurnIdRef.current = turnId;
    
    // Check if this turn is still active (not superseded by barge-in)
    const isTurnActive = () => activeTurnIdRef.current === turnId;
    
    try {
      // Generate AI response immediately
      logInfo(`[AI] AI_STARTED ${turnId} (from dispatcher)`);
      let reply: string;
      
      if (isMock) {
        reply = getAgentReply(historyRef.current, currentScenario);
        logInfo("[AI] Generated mock reply:", reply);
      } else {
        try {
          logInfo("[AI] Calling OpenAI API for live response (from dispatcher)");
          const messages = historyRef.current.map(turn => ({
            role: turn.role,
            text: turn.text
          }));
          
          const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
              messages,
              scenario: currentScenario
            })
          });
          
          if (response.ok) {
            const data = await response.json();
            reply = data.content || "I didn't catch that. Could you please repeat?";
            logInfo("[AI] Generated live AI reply:", reply);
          } else {
            logWarn("[AI] OpenAI API failed, falling back to mock");
            reply = getAgentReply(historyRef.current, currentScenario);
          }
        } catch (error) {
          logWarn("[AI] OpenAI API error, falling back to mock:", error);
          reply = getAgentReply(historyRef.current, currentScenario);
        }
      }
      
      // Check if turn was superseded during AI generation
      if (!isTurnActive()) {
        logInfo(`[AI] AI_DROPPED ${turnId} (stale)`);
        return {
          id: turnId,
          text: '',
          success: false,
          error: 'Turn superseded'
        };
      }
      
      // Add assistant turn to history
      pushTurn("agent", reply);
      
      // Generate TTS if in live mode
      if (!isMock && voiceConnectedRef.current) {
        // Start TTS generation immediately
        const ttsPromise = (async () => {
          // Check if TTS already started for this turnId (idempotent)
          if (ttsStartedRef.current.has(turnId)) {
            logInfo(`[TTS] TTS already started for turnId ${turnId}, ignoring duplicate request`);
            return null;
          }
          
          // Mark TTS as started for this turnId
          ttsStartedRef.current.add(turnId);
          logInfo(`[AI→TTS] Start ${turnId}`);
          
          // Set AI playing state for barge-in detection
          aiPlayingRef.current = true;
          agentSpeakingRef.current = true;
          
          try {
            // Use the existing TTS pipeline
            await agentSpeak(reply, new AbortController().signal);
            logInfo(`[AI→TTS] Done ${turnId}`);
          } catch (error) {
            logError(`[TTS] TTS failed for turnId ${turnId}:`, error);
          } finally {
            ttsStartedRef.current.delete(turnId);
            // Clear AI playing state
            aiPlayingRef.current = false;
            agentSpeakingRef.current = false;
          }
        })();
        
        // Don't wait for TTS to complete
        ttsPromise.catch(error => {
          logError(`[TTS] TTS promise error for turnId ${turnId}:`, error);
        });
      }
      
      return {
        id: turnId,
        text: reply,
        success: true
      };
      
    } catch (error) {
      logError(`[AI] Error processing message for turnId ${turnId}:`, error);
      return {
        id: turnId,
        text: '',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  };

  // Handle user utterances from chat window
  const handleChatUserUtterance = async (text: string) => {
    console.log("[Chat] User utterance from chat:", text);
    
    // Add user turn to history
    pushTurn("user", text);
    
    // Generate AI response if we have a scenario
    if (currentScenario) {
      // Generate unique turn ID for this interaction
      const turnId = crypto.randomUUID();
      activeTurnIdRef.current = turnId;
      
      // Check if this turn is still active (not superseded by barge-in)
      const isTurnActive = () => activeTurnIdRef.current === turnId;
      
      // Generate AI response immediately
      console.log(`[AI] AI_STARTED ${turnId} (from chat)`);
      let reply: string;
      if (isMock) {
        reply = getAgentReply(historyRef.current, currentScenario);
        console.log("[AI] Generated mock reply:", reply);
      } else {
        try {
          console.log("[AI] Calling OpenAI API for live response (from chat)");
          const messages = historyRef.current.map(turn => ({
            role: turn.role,
            text: turn.text
          }));
          
          const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
              messages,
              scenario: currentScenario
            })
          });
          
          if (response.ok) {
            const data = await response.json();
            reply = data.content || "I didn't catch that. Could you please repeat?";
            console.log("[AI] Generated live AI reply:", reply);
          } else {
            console.warn("[AI] OpenAI API failed, falling back to mock");
            reply = getAgentReply(historyRef.current, currentScenario);
          }
        } catch (error) {
          console.warn("[AI] OpenAI API error, falling back to mock:", error);
          reply = getAgentReply(historyRef.current, currentScenario);
        }
      }
      
      // Check if turn was superseded during AI generation
      if (!isTurnActive()) {
        console.log(`[AI] AI_DROPPED ${turnId} (stale)`);
        return;
      }
      
      // Check assistant deduplication
      const normalizedReply = reply.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
      const now = Date.now();
      
      // Clean old entries
      for (const [text, timestamp] of recentAssistantTexts.current.entries()) {
        if (now - timestamp > ASSISTANT_DEDUP_MS) {
          recentAssistantTexts.current.delete(text);
        }
      }
      
      if (recentAssistantTexts.current.has(normalizedReply)) {
        console.log(`[ASSIST_DEDUP_HIT] "${normalizedReply}"`);
        return; // Don't speak duplicate assistant text
      }
      
      recentAssistantTexts.current.set(normalizedReply, now);
      
      // Add assistant turn to history
      pushTurn("agent", reply);
      
      // Generate TTS if in live mode
      if (!isMock && voiceConnectedRef.current) {
        // Start TTS generation immediately using high-quality model (single-flight, idempotent)
        const ttsPromise = (async () => {
          // Check if TTS already started for this turnId (idempotent)
          if (ttsStartedRef.current.has(turnId)) {
            console.log(`[TTS] TTS already started for turnId ${turnId}, ignoring duplicate request`);
            return null;
          }
          
          // Mark TTS as started for this turnId
          ttsStartedRef.current.add(turnId);
          console.log(`[TTS] TTS_STARTED ${turnId} (from chat)`);
          
          try {
            // Use the same high-quality TTS as greeting (gpt-4o-mini-tts)
            const r = await fetch("/api/tts", { 
              method: "POST", 
              headers: { "Content-Type": "application/json" }, 
              body: JSON.stringify({ 
                text: reply,
                voice: "alloy", // Consistent voice
                format: "mp3" // High-quality format
              }) 
            });
            if (r.ok) { 
              const j = await r.json(); 
              console.log("[TTS] Generated high-quality audio for AI response (from chat):", j.url);
              return j.url;
            } else {
              console.warn("[TTS] High-quality TTS failed:", r.status);
            }
          } catch (e) {
            console.warn("[TTS] Error generating audio:", e);
          }
          return null;
        })();
        
        // Store pending TTS for potential cancellation
        pendingTtsRef.current = null; // No cancel function for audio element approach
        
        // Wait for TTS to complete
        const aurl = await ttsPromise;
        
        // Check if turn was superseded during TTS generation
        if (!isTurnActive()) {
          console.log(`[AI] AI_DROPPED ${turnId} (stale)`);
          return;
        }
        
        if (aurl) {
          // Final check if turn is still active before playing
          if (!isTurnActive()) {
            console.log(`[AI] AI_DROPPED ${turnId} (stale)`);
            return;
          }
          
          // Play the AI response immediately with high-quality settings
          try {
            // Enter AI playing state
            enterAIPlaying();
            
            // Use dedicated audio element for AI response with high-quality settings
            const timestamp = Date.now();
            const aiResponseEl = await ensureAudioEl(`aiResponse_${timestamp}`, { 
              volume: 0.7, 
              routeToDevice: 'none' // Don't try to route to specific device
            });
            
            // Set src after sinkId has been configured
            aiResponseEl.src = aurl;
            
            // Setup AI analyzer for echo suppression
            setupAIAnalyzer(aiResponseEl);
            
                        // Set up event listener to handle when AI audio ends
            const handleResponseEnd = () => {
              aiResponseEl.removeEventListener('ended', handleResponseEnd);
              // Clean up AI analyzer
              aiAnalyserRef.current = null;
              aiSourceRef.current = null;
              // Exit AI playing state
              exitAIPlaying();
              // Remove the audio element to prevent memory leaks
              try {
                if (aiResponseEl.parentNode) {
                  aiResponseEl.parentNode.removeChild(aiResponseEl);
                }
              } catch (e) {
                console.warn("[Cleanup] Failed to remove audio element:", e);
              }
            };
            aiResponseEl.addEventListener('ended', handleResponseEnd);
            
            await aiResponseEl.play();
            console.log("[LiveCall] Playing AI response (from chat):", aurl);
          } catch (e) {
            console.warn("[LiveCall] Failed to play AI response:", e);
            // Exit AI playing state on error
            exitAIPlaying();
          }
        }
      }
    }
  };

  // Legacy barge-in monitoring functions removed - now using modular BargeInDetector
  // Legacy barge-in monitoring functions removed - now using modular BargeInDetector

  // Barge-in handler - cancels audio playback only, preserves assistant text
  const handleBargeIn = async () => {
    // Check if component is still mounted (handles Fast Refresh interruptions)
    if (!mountedRef.current) {
      console.log("[BARGE-IN] Component unmounted, skipping barge-in");
      return;
    }
    
    // Double-check state to prevent race conditions
    if (callStateRef.current !== 'ai_playing') {
      console.log("[BARGE-IN] Not in ai_playing state, skipping barge-in");
      return;
    }
    
    if (!bargeInDetectedRef.current) {
      console.log("[BARGE-IN] Entering barge-in state");
      
      // Mark barge-in as detected to prevent double execution
      bargeInDetectedRef.current = true;
      
      // Update modular state
      if (callSessionRef.current) {
        callSessionRef.current.setAIPlaying(false);
        callSessionRef.current.setUserSpeaking(true);
      }
      
      // 1. Immediately set legacy state flags before cancelling TTS
      aiPlayingRef.current = false;
      ttsPlayingRef.current = false;
      bargeActiveRef.current = true;
      
      console.log("[BARGE-IN] ai_playing:false, tts_playing:false, barge_active:true");
      
      // Stop only the interrupted audio playback
      stopInterruptedAudioPlayback();
      
      // Ensure audio context is resumed after barge-in
      try {
        const audioContext = audioManager.getAudioContext();
        if (audioContext && audioContext.state === 'suspended') {
          await audioContext.resume();
          console.log("[BARGE-IN] AudioContext resumed after barge-in");
        }
        console.log("[BARGE-IN] AudioContext state after barge-in:", audioContext?.state);
      } catch (e) {
        console.warn("[BARGE-IN] Failed to resume AudioContext:", e);
      }
      
      // Start tracking continuous speech for kill switch
      if (continuousSpeechStartRef.current === null) {
        continuousSpeechStartRef.current = Date.now();
        console.log("[BARGE-IN] Starting continuous speech tracking");
      }
      
      // Enter user speaking state (barge-in)
      enterUserSpeaking();
      
      // Note: Do NOT clear activeTurnIdRef or ttsStartedRef here
      // Only discard assistant text if a newer assistant message has been generated
    }
  };
  
  // Subscription and turn sequence management
  const unsubRef = useRef<(() => void) | null>(null);
  const turnSeqRef = useRef<number>(0);

  // HMR protection - set mounted flag
  useEffect(() => {
    mountedRef.current = true;
    console.log("[HMR] Component mounted");
    
    // Register message dispatcher handler
    registerMessageHandler(handleMessageDispatcher);
    
    // Check if we're in development mode and handle Fast Refresh interruptions
    const isDevelopment = process.env.NODE_ENV === 'development';
    if (isDevelopment) {
      console.log("[HMR] Development mode detected - Fast Refresh may interrupt barge-in");
      
      // Check for URL parameter to disable Fast Refresh warnings
      const urlParams = new URLSearchParams(window.location.search);
      const disableFastRefresh = urlParams.get('disableFastRefresh');
      if (disableFastRefresh) {
        console.log("[HMR] Fast Refresh warnings disabled via URL parameter");
      }
    }
    
    return () => {
      mountedRef.current = false;
      console.log("[HMR] Component unmounting, running cleanup");
      // Unregister message dispatcher handler
      unregisterMessageHandler(handleMessageDispatcher);
      cleanup();
    };
  }, []);

  // hydrate showChat from localStorage to avoid flicker, or show by default in live mode
  useEffect(() => {
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem("showChatDebug") : null;
      if (raw === "1") {
        setShowChat(true);
      } else if (!isMock) {
        // Show chat by default in live mode
        setShowChat(true);
      }
    } catch {}
  }, [isMock]);

  // helper to push turns with adjacent de-dupe and reflect into ChatWindow + history
  function pushTurn(role: "user" | "agent", text: string, extra?: { wpm?: number; interrupted?: boolean; audioUrl?: string }) {
    const trimmed = (text || "").trim();
    if (!trimmed) return;
    const hash = `${role}|${trimmed}`;
    if (hash === lastHashRef.current) return;
    const last = historyRef.current[historyRef.current.length - 1];
    const lastHash = last ? `${last.role}|${(last.text || "").trim()}` : "";
    if (hash === lastHash) return;
    const at = Math.max(0, Date.now() - (connectedAtRef.current || Date.now()));
    historyRef.current.push({ role, text: trimmed, at, wpm: extra?.wpm, interrupted: extra?.interrupted, audioUrl: extra?.audioUrl });
    lastHashRef.current = hash;
    setExternalTurn({ role: role === "user" ? "user" : "bot", text: trimmed, timestamp: Date.now() });
  }

  async function uploadBlobGetUrl(blob: Blob): Promise<string | null> {
    try {
      console.log("[Upload] Starting upload - blob size:", blob.size);
      const fd = new FormData();
      fd.append("file", new File([blob], "clip.webm", { type: blob.type || "audio/webm" }));
      const res = await fetch("/api/upload-audio", { method: "POST", body: fd });
      console.log("[Upload] Response status:", res.status);
      if (!res.ok) {
        console.warn("[Upload] Upload failed - status:", res.status);
        return null;
      }
      const data = await res.json();
      console.log("[Upload] Upload success - data:", data);
      return data?.url || data?.audioUrl || null;
    } catch (e) {
      console.warn("[Upload] Upload error:", e);
      return null;
    }
  }

  function synthBeepWav(seconds = 1, freq = 560): Blob {
    const sampleRate = 44100;
    const length = sampleRate * seconds;
    const buffer = new ArrayBuffer(44 + length * 2);
    const view = new DataView(buffer);
    function w(off: number, s: string) { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); }
    w(0,'RIFF'); view.setUint32(4, 36 + length * 2, true); w(8,'WAVE'); w(12,'fmt ');
    view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true); view.setUint32(24,sampleRate,true);
    view.setUint32(28,sampleRate*2,true); view.setUint16(32,2,true); view.setUint16(34,16,true); w(36,'data'); view.setUint32(40,length*2,true);
    let off = 44;
    for (let i=0;i<length;i++){ const t=i/sampleRate; const s=Math.sin(2*Math.PI*freq*t)*0.25; view.setInt16(off, Math.floor(s*32767), true); off+=2; }
    return new Blob([buffer], { type: 'audio/wav' });
  }
  
  // Removed user audio fallback logic - not needed with echo suppression

  // Start a MediaRecorder on a single track and resolve to an object URL on stop
  function startRecorderForTrack(track: MediaStreamTrack): { rec: MediaRecorder; done: Promise<string | null> } {
    const stream = new MediaStream([track]);
    const rec = new MediaRecorder(stream);
    const chunks: BlobPart[] = [];
    let resolveDone: (url: string | null) => void = () => {};
    const done = new Promise<string | null>((resolve) => { resolveDone = resolve; });
    rec.ondataavailable = (e: BlobEvent) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      try {
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        console.log("[Recorder] Blob created - size:", blob.size, "type:", blob.type);
        
        // Don't upload if the blob is too small (likely empty or just silence)
        if (blob.size < 1000) {
          console.warn("[Recorder] Blob too small, skipping upload:", blob.size, "bytes");
          resolveDone(null);
          return;
        }
        
        // Upload to persistent URL instead of creating blob URL
        const uploadedUrl = await uploadBlobGetUrl(blob);
        console.log("[Recorder] Upload result:", uploadedUrl);
        resolveDone(uploadedUrl);
      } catch (e) {
        console.warn("[Recorder] Upload failed:", e);
        resolveDone(null);
      }
    };
    try { rec.start(); } catch {}
    return { rec, done };
  }

// LIVEKIT: connect & publish mic
async function startLiveKitCall(identity = "user", roomName = "sales-sim") {
  const res = await fetch(`/api/getToken?identity=${identity}&roomName=${roomName}`);
  const { token } = await res.json();
  if (!token) throw new Error("No LiveKit token returned");

  const url = process.env.NEXT_PUBLIC_LIVEKIT_URL || "";
  if (!url || !url.startsWith("wss://")) {
    throw new Error(`Bad LIVEKIT_URL: "${url}"`);
  }

  const room = new Room();
  await room.connect(url, token);

  let audioTrack;
  try {
    console.log("[LiveKit] Getting mic stream from mic.ts...");
    
    // Get mic stream from mic.ts singleton first
    const micStream = await mic.getMicStream();
    const micTrack = mic.getMicTrack();
    
    if (!micTrack) {
      throw new Error("No mic track available from mic.ts");
    }
    
    console.log("[LiveKit] Creating audio track...");
    // Create LiveKit track - it should use the same mic stream since we got it from mic.ts first
    audioTrack = await createLocalAudioTrack();
    console.log("[LiveKit] Audio track created successfully");
    
    // Verify we're using the same track
    const publishedTrack = audioTrack.mediaStreamTrack;
    if (publishedTrack.id !== micTrack.id) {
      logWarn("[LiveKit] Track ID mismatch - LiveKit created different track");
              logWarn("[LiveKit] This may cause mic detection issues");
    }
    await room.localParticipant.publishTrack(audioTrack);
    
    // Log and assert track state
    logChange('mic-track-id', publishedTrack.id, '[Mic/Publish] Track ID', { micTrackId: micTrack.id, publishedTrackId: publishedTrack.id });
    logChange('mic-track-state', `${publishedTrack.enabled}-${publishedTrack.muted}-${publishedTrack.readyState}`, '[Mic/State] Track state', { 
      enabled: publishedTrack.enabled, 
      muted: publishedTrack.muted, 
      readyState: publishedTrack.readyState 
    });
    
    // Assert track state
    if (!publishedTrack.enabled) {
      console.warn('[Mic/State] Track not properly enabled - fixing...');
      publishedTrack.enabled = true;
    }
    
    // keep a reference for per-turn user recording
    localMicTrackRef.current = publishedTrack;
    console.log("[LiveKit] Audio track published to room");
  } catch (error: any) {
    console.error('LiveKit audio track creation failed:', error);
    console.log("[LiveKit] Error details:", error?.name, error?.message);
    // Continue without audio track - the call can still work for listening
    audioTrack = null;
  }

  // Local mic monitor (muted) - only for mic monitoring, not TTS
  const micTimestamp = Date.now();
  const micEl = await ensureAudioEl(`micMonitor_${micTimestamp}`, { routeToDevice: 'none' });
  micEl.muted = true;
  micEl.autoplay = true;
  // @ts-expect-error playsInline exists on HTMLMediaElement in browsers
  micEl.playsInline = true;
  try {
    if (audioTrack?.mediaStreamTrack) {
      micEl.srcObject = new MediaStream([audioTrack.mediaStreamTrack]);
      micEl.play?.().catch(() => {});
    }
  } catch {}

  // Remote audio subscription (for agent audio from LiveKit, not TTS)
  room.on("trackSubscribed", async (track: any) => {
    try {
      if (track?.kind === "audio" || track?.kind === 2) {
        if (track?.mediaStreamTrack) agentTrackRef.current = track.mediaStreamTrack as MediaStreamTrack;
        const agentTimestamp = Date.now();
        const agentEl = await ensureAudioEl(`agentMonitor_${agentTimestamp}`, { routeToDevice: 'none' });
        agentEl.muted = false;
        agentEl.autoplay = true;
        // @ts-expect-error playsInline exists on HTMLMediaElement in browsers
        agentEl.playsInline = true;
        try {
          if (typeof track.attach === "function") {
            const el = track.attach();
            if (!agentEl.srcObject && (el as any).srcObject) {
              agentEl.srcObject = (el as any).srcObject as MediaStream;
            } else if (track.mediaStreamTrack) {
              agentEl.srcObject = new MediaStream([track.mediaStreamTrack]);
            }
          } else if (track.mediaStreamTrack) {
            agentEl.srcObject = new MediaStream([track.mediaStreamTrack]);
          }
          agentEl.play().catch(() => {});
        } catch {}
      }
    } catch {}
  });

  (window as any).__livekitAudio = {
    room,
    localTrack: audioTrack || null,
    micElId: "micMonitor",
    agentElId: "agentMonitor",
  };

  roomRef.current = room;
  setVoiceConnected(true);
  setMessageDispatcherConnected(true);
  console.log("LiveKit: connected & mic published");
}

// LIVEKIT: disconnect
async function endLiveKitCall() {
  try {
    // Stop any in-progress per-turn recorders
    try { userRecRef.current?.stop(); } catch {}
    try { agentRecRef.current?.stop(); } catch {}
    userRecRef.current = null; agentRecRef.current = null;
    const refs = (window as any).__livekitAudio;
    if (refs?.localTrack) {
      try { await refs.room?.localParticipant.unpublishTrack(refs.localTrack); } catch {}
      try { refs.localTrack.stop(); } catch {}
    }
    const micEl = document.getElementById(refs?.micElId) as HTMLAudioElement | null;
    if (micEl) { try { micEl.pause(); } catch {} micEl.srcObject = null; micEl.remove(); }
    const agentEl = document.getElementById(refs?.agentElId) as HTMLAudioElement | null;
    if (agentEl) { try { agentEl.pause(); } catch {} agentEl.srcObject = null; agentEl.remove(); }
    try {
      refs?.room?.participants.forEach((p: any) => {
        p.audioTracks.forEach((pub: any) => {
          const t: any = pub?.audioTrack;
          if (t?.detach) {
            try { t.detach().forEach((el: HTMLMediaElement) => { try { el.pause?.(); } catch {}; (el as any).srcObject = null; el.remove?.(); }); } catch {}
          }
        });
      });
    } catch {}
  } catch {}
  finally {
    try { await roomRef.current?.disconnect(); } catch {}
    roomRef.current = null;
    setVoiceConnected(false);
    setMessageDispatcherConnected(false);
    console.log("LiveKit: disconnected");
  }
}

  async function handleCall() {
    // Prevent re-initialization during hot-reload
    if (isCallActiveRef.current) {
      console.log("[Call] Call already active, skipping re-initialization");
      return;
    }
    
    console.log("[Call] Starting call...");
    isCallActiveRef.current = true;
    
    setIsInitializing(true);
    setInitError(null);
    
    // Add timeout to prevent hanging
    const callTimeout = setTimeout(() => {
      console.warn("[Call] Call setup timeout - continuing with limited functionality");
      setInitError("Call setup took longer than expected, but continuing...");
    }, 10000); // 10 second timeout
    
    try {
      // Start LiveKit first with timeout
      const livekitPromise = startLiveKitCall("test-user", "sales-sim");
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("LiveKit connection timeout")), 5000)
      );
      
      await Promise.race([livekitPromise, timeoutPromise]);
    } catch (error) {
      console.error("[Call] startLiveKitCall failed:", error);
      setInitError("Failed to connect to voice service, but continuing with limited functionality");
      // Continue anyway - might still work for mock mode
    } finally {
      clearTimeout(callTimeout);
    }

    if (!machineRef.current) machineRef.current = new CallMachine();
    const m = machineRef.current;
    m.start();
    setVoiceConnected(false);
    setTimeout(() => { m.answer(); setVoiceConnected(true); voiceConnectedRef.current = true; connectedAtRef.current = Date.now(); }, 1200);
    startedAtRef.current = Date.now();
    callIdRef.current = crypto.randomUUID();
    
    // Initialize waiting flag to true since we're waiting for user input after greeting
    waitingForUserRef.current = true;
    
    // Removed fallback audio creation - not needed with echo suppression
    
    // Log reply mode on startup
    console.log(`[Guard] REPLY_MODE: ${isMock ? 'mock' : 'live'}`);
    
    // Initialize CloserCoach-style audio pipeline
    try {
      console.log("[Audio] Initializing CloserCoach-style audio pipeline...");
      
      // Initialize singleton AudioContext and microphone
      await audioManager.initializeAudioContext();
      const stream = await mic.getMicStream();
      
      if (stream) {
        console.log("[Audio] Stream obtained:", stream);
        setMicStream(stream);
        micStreamRef.current = stream;
        
        // Setup modular audio manager with mic stream
        if (audioManagerRef.current) {
          await audioManagerRef.current.initializeAudioContext();
          audioManagerRef.current.setupMicAnalyzer(stream);
        }
        
        // Setup legacy audio analysis for VAD
        const audioContext = audioManager.getAudioContext();
        if (audioContext) {
          mic.setupAudioAnalysis(audioContext);
        }
        
        // Ensure microphone is always enabled (never disable the track)
        mic.ensureMicEnabled();
        console.log("[Audio] Microphone always enabled for barge-in");
        
        // Update mic track status
        updateMicTrackStatus();
      } else {
        throw new Error("Failed to get microphone stream");
      }
      
    } catch (err: any) { 
      console.error('Audio initialization failed:', err); 
      console.log("[Audio] Error name:", err?.name);
      console.log("[Audio] Error message:", err?.message);
      
      if (err?.name === 'NotAllowedError') {
        setInitError("Microphone access denied. Please allow microphone access and try again.");
        alert('Please allow microphone access when prompted, then try again.');
      } else if (err?.name === 'NotFoundError') {
        setInitError("No microphone devices found. Please check your microphone connection and browser settings.");
        alert("No microphone devices detected. Please check your microphone connection and try again.");
      } else {
        setInitError("Failed to access microphone. The call may work with limited functionality.");
      }
    }
    
    // Agent greeting once connected (single guard)
    unsubRef.current = m.subscribe(async (state) => {
      if (state === "connected") {
        unsubRef.current?.();
        unsubRef.current = null;
        if (!greetedRef.current) {
          greetedRef.current = true;
          const greeting = currentScenario
            ? `Hi, this is ${currentScenario.persona}. ${currentScenario.brief.split(".")[0]}.`
            : "Hi, thanks for calling.";
          
          const useTtsStub = isMock || !voiceConnectedRef.current;
          let gurl: string | null = null;
          if (useTtsStub) {
            const r = await fetch("/api/tts", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ 
                text: greeting,
                voice: "alloy", // Consistent voice
                format: "mp3" // High-quality format
              }),
            });
            const j = r.ok ? await r.json() : null;
            gurl = j?.url ?? null;
          }
          
          pushTurn("agent", greeting, { audioUrl: useTtsStub ? gurl || undefined : undefined });
          
                      // Play the greeting immediately using a dedicated audio element
          if (useTtsStub && gurl) {
            try {
              // Enter AI playing state
              enterAIPlaying();
              
              // Use legacy audio system for reliable TTS playback
              const ttsPlayback = await audioManager.playTtsAudio(gurl, {
                volume: 0.7,
                onComplete: () => {
                  exitAIPlaying();
                }
              });
              pendingTtsRef.current = ttsPlayback;
              
              console.log("[LiveCall] Playing greeting:", gurl);
            } catch (e) {
              console.warn("[LiveCall] Failed to play greeting:", e);
              // Exit AI playing state on error
              exitAIPlaying();
            }
          } else {
            // No greeting audio - start speech recognition immediately
            console.log("[Speech] No greeting audio, starting speech recognition immediately");
            setTimeout(async () => {
              if (mountedRef.current && speechRef.current) {
                try {
                  await speechRef.current.start();
                  console.log("[Speech] Speech recognition started (no greeting)");
                } catch (e) {
                  console.warn("[Speech] Failed to start speech recognition:", e);
                }
              }
            }, 1000); // Short delay to ensure everything is ready
          }
          
          await new Promise((res) => setTimeout(res, 600 + Math.floor(Math.random() * 400)));
        }
        
        // Start continuous enhanced speech with singleton guard
        if (!speechInstanceRef.current && mountedRef.current) {
          console.log("[Speech] Creating new speech recognition instance with singleton guard");
          
          // Cleanly dispose previous instance if it exists
          if (speechRef.current) {
            try {
              speechRef.current.stop();
            } catch (e) {
              console.warn("[Speech] Error disposing previous speech instance:", e);
            }
            speechRef.current = null;
          }
          
          // Pre-create and warm up the recognizer for faster first token
          const warmUpRecognizer = async () => {
            try {
              const tempSpeech = createEnhancedSpeech({
                onFinal: () => {}, // No-op for warm-up
                onInterim: () => {}, // No-op for warm-up
                onSpeechStart: () => {
                  console.log("[Speech] Warm-up recognizer started");
                },
                onSpeechEnd: () => {
                  console.log("[Speech] Warm-up recognizer ended");
                }
              });
              
              if (tempSpeech) {
                try {
                  await tempSpeech.start();
                } catch (e) {
                  console.warn("[Speech] Error starting warm-up recognizer:", e);
                }
                // Stop after a short time
                setTimeout(() => {
                  try {
                    tempSpeech.stop();
                  } catch (e) {
                    console.warn("[Speech] Error stopping warm-up recognizer:", e);
                  }
                }, 1000);
              }
            } catch (e) {
              console.warn("[Speech] Failed to warm up recognizer:", e);
            }
          };
          
          // Warm up the recognizer
          warmUpRecognizer().catch(e => {
            console.warn("[Speech] Warm-up failed:", e);
          });
          
          speechInstanceRef.current = createEnhancedSpeech({
            onInterim: (partialText: string) => {
              // Always allow interim results for barge-in detection
              // Only gate the display, not the detection
              if (aiPlayingRef.current === true && bargeActiveRef.current === false) {
                // Don't display interim results during AI playback, but still allow detection
                return;
              }
              
              // Text chat mirror - show partial results in live mode
              if (!isMock) {
                setAsrPartials(partialText);
              }
            },
            onBargeIn: () => {
              // Trigger barge-in whenever speech is detected during AI playback
              // The message dispatcher will handle the actual AI response
              console.log("[Speech] Barge-in triggered - stopping any current TTS");
              handleBargeIn();
            },
            onLowConfidence: (text: string, confidence: number) => {
              console.log(`[Speech] Low confidence utterance: "${text}" (${confidence.toFixed(2)})`);
              // For now, just log it. In the future, we could send a confirmation request to the AI
            },
            onSpeechStart: () => {
              console.log("[Speech] Speech started");
              
              // Update modular ASRManager speech state - ALWAYS update this
              if (asrManagerRef.current) {
                asrManagerRef.current.updateSpeechState(true);
              }
              
              // Debug: Log speech detection during AI playback
              if (aiPlayingRef.current) {
                console.log("[Speech] Speech detected during AI playback - barge-in should trigger");
              }
              
              // Force speech recognition to work during AI playback
              // This ensures that speech detection continues even with AI audio playing
              console.log("[Speech] Forcing speech recognition to work during AI playback");
              
              // Initialize echo suppression if not already done
              setupMicAnalyzer();
              
              // Update mic track status
              updateMicTrackStatus();
              
              // Check for barge-in kill switch (continuous speech for 150-200ms)
              if (continuousSpeechStartRef.current !== null) {
                const speechDuration = Date.now() - continuousSpeechStartRef.current;
                if (speechDuration >= 175) { // BARGE_IN_THRESHOLD_MS
                  console.log(`[BARGE-IN] Kill switch triggered after ${speechDuration}ms of continuous speech`);
                  // Mark the current reply as superseded - don't resume or enqueue another copy
                  activeTurnIdRef.current = null;
                  pendingTtsRef.current = null;
                  ttsStartedRef.current.clear();
                }
              }
              
              // Start recording using the direct mic stream we already have
              try {
                const stream = micStreamRef.current || micStream || mic.getStream();
                if (stream && stream.getAudioTracks().length > 0) {
                  const audioTrack = stream.getAudioTracks()[0];
                  if (audioTrack.enabled && audioTrack.readyState === 'live') {
                    const { rec, done } = startRecorderForTrack(audioTrack);
                    userRecRef.current = rec;
                    userRecDoneRef.current = done;
                    attemptedRecordingRef.current = true;
                    console.log("[UserAudio] Started recording from mic stream");
                  } else {
                    console.warn("[UserAudio] Microphone track not ready - enabled:", audioTrack.enabled, "readyState:", audioTrack.readyState);
                    attemptedRecordingRef.current = false;
                  }
                } else {
                  console.warn("[UserAudio] No mic stream available for recording");
                  attemptedRecordingRef.current = false;
                }
              } catch (e) {
                console.warn("[UserAudio] Failed to start recording:", e);
                attemptedRecordingRef.current = false;
              }
            },
            onSpeechEnd: async () => {
              console.log("[UserAudio] Speech ended, waiting for per-turn recording to complete");
              
              // Update modular ASRManager speech state
              if (asrManagerRef.current) {
                asrManagerRef.current.updateSpeechState(false);
              }
              
              // Update mic track status
              updateMicTrackStatus();
              
              // Reset continuous speech tracking
              continuousSpeechStartRef.current = null;
              if (bargeInTimerRef.current) {
                clearTimeout(bargeInTimerRef.current);
                bargeInTimerRef.current = null;
              }
            },
            onFinal: async (finalText: string) => {
              console.log("[Speech] Final text:", finalText);
              
              // DISABLED: Original AI response system - now handled by message dispatcher
              // The message dispatcher will handle all AI responses and TTS
              console.log("[Speech] Original AI response system disabled - using message dispatcher");
              return;
              
              // Only ignore finals if ai_playing===true and barge_active===false
              // But allow speech if barge-in was detected
              if (aiPlayingRef.current === true && bargeActiveRef.current === false && !bargeInDetectedRef.current) {
                console.log("[Speech] Ignoring final text during AI playback (no barge-in detected)");
                console.log("[Speech] Debug - aiPlaying:", aiPlayingRef.current, "bargeActive:", bargeActiveRef.current, "bargeDetected:", bargeInDetectedRef.current);
                return;
              }
              
              // Text chat mirror - clear partials and add final
              if (!isMock) {
                setAsrPartials("");
                setAsrFinals(prev => [...prev.slice(-9), finalText]); // Keep last 10
              }
              
              // Check echo gate - only proceed if mic is louder than AI
              // Use default values since enhanced speech doesn't provide confidence/duration
              const confidence = 0.95; // Default high confidence
              const duration = 2000; // Default 2 seconds
              if (agentSpeakingRef.current && !checkEchoGate(finalText, confidence, duration)) {
                logDroppedItem(finalText, "echo_gate");
                return; // Drop this utterance as echo
              }
              
              // Call AI immediately - don't wait for audio uploads
              const words = finalText.split(/\s+/).filter(Boolean).length;
              const wpm = Math.round((words / 2) * 60); // rough fallback with 2s assumed
              
              // Stop per-turn recorder but don't wait for it
              let turnUrl: string | null = null;
              try { 
                userRecRef.current?.stop(); 
                // Upload audio in background, don't wait for it
                userRecDoneRef.current?.then(url => {
                  if (url) {
                    console.log("[UserAudio] Background upload completed:", url);
                    // Update the turn with the audio URL if we can find it
                    const lastTurn = historyRef.current[historyRef.current.length - 1];
                    if (lastTurn && lastTurn.role === "user" && lastTurn.text === finalText) {
                      lastTurn.audioUrl = url;
                    }
                  }
                });
              } catch (e) {
                console.warn("[UserAudio] Recording failed:", e);
              }
              userRecRef.current = null; 
              userRecDoneRef.current = null;
              
              // Use actual recorded audio or undefined - no fallbacks
              const audioUrl = turnUrl || undefined;
              attemptedRecordingRef.current = false; // Reset for next turn
              console.log("[UserAudio] Final audio URL for turn:", audioUrl);
              pushTurn("user", finalText, { wpm, audioUrl });
              console.log("[Turn:user]", { text: finalText.slice(0,40), audioUrl });
              
              // Reset barge-in state after user's turn is processed
              bargeActiveRef.current = false;
              bargeInDetectedRef.current = false; // Reset barge-in detection for next turn
              console.log("[State] barge_active:false, barge_in_detected:false after user turn processed");
              
              // Call AI immediately without delays - strict turn management
              if (currentScenario) {
                // Generate unique turn ID for this interaction
                const turnId = crypto.randomUUID();
                activeTurnIdRef.current = turnId;
                currentTurnIdRef.current = turnId;
                
                // Check if this turn is still active (not superseded by barge-in)
                const isTurnActive = () => activeTurnIdRef.current === turnId;
                
                // Generate AI response immediately
                console.log(`[AI] AI_STARTED ${turnId}`);
                let reply: string;
                if (isMock) {
                  reply = getAgentReply(historyRef.current, currentScenario);
                  console.log("[AI] Generated mock reply:", reply);
                } else {
                  try {
                    console.log("[AI] Calling OpenAI API for live response");
                    const messages = historyRef.current.map(turn => ({
                      role: turn.role,
                      text: turn.text
                    }));
                    
                    const response = await fetch("/api/chat", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ 
                        messages,
                        scenario: currentScenario
                      })
                    });
                    
                    if (response.ok) {
                      const data = await response.json();
                      reply = data.content || "I didn't catch that. Could you please repeat?";
                      console.log("[AI] Generated live AI reply:", reply);
                    } else {
                      console.warn("[AI] OpenAI API failed, falling back to mock");
                      reply = getAgentReply(historyRef.current, currentScenario);
                    }
                  } catch (error) {
                    console.warn("[AI] OpenAI API error, falling back to mock:", error);
                    reply = getAgentReply(historyRef.current, currentScenario);
                  }
                }
                
                // Check if turn was superseded during AI generation
                if (!isTurnActive()) {
                  console.log(`[AI] AI_DROPPED ${turnId} (stale)`);
                  return;
                }
                
                // Start per-turn agent recorder as soon as we have remote track
                if (!agentRecRef.current && agentTrackRef.current) {
                  try {
                    const { rec, done } = startRecorderForTrack(agentTrackRef.current);
                    agentRecRef.current = rec;
                    agentRecDoneRef.current = done;
                  } catch {}
                }
                
                // Check if turn was superseded before TTS generation
                if (currentTurnIdRef.current !== turnId) {
                  console.log(`[AI] AI_DROPPED ${turnId} (superseded by ${currentTurnIdRef.current})`);
                  return;
                }
                
                // Check assistant deduplication
                const normalizedReply = reply.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
                const now = Date.now();
                
                // Clean old entries
                for (const [text, timestamp] of recentAssistantTexts.current.entries()) {
                  if (now - timestamp > ASSISTANT_DEDUP_MS) {
                    recentAssistantTexts.current.delete(text);
                  }
                }
                
                if (recentAssistantTexts.current.has(normalizedReply)) {
                  console.log(`[ASSIST_DEDUP_HIT] "${normalizedReply}"`);
                  return; // Don't speak duplicate assistant text
                }
                
                recentAssistantTexts.current.set(normalizedReply, now);
                
                // Use high-quality TTS for both greeting and replies (same quality path)
                // No "fast" TTS endpoint - always use gpt-4o-mini-tts for consistent quality
                const useTtsStub = isMock || !voiceConnectedRef.current;
                let aurl: string | null = null;
                
                // Start TTS generation immediately using high-quality model (single-flight, idempotent)
                const ttsPromise = (async () => {
                  // Single-flight guard - only allow current turnId to generate TTS
                  if (currentTurnIdRef.current !== turnId) {
                    console.log(`[TTS] Turn ${turnId} superseded by ${currentTurnIdRef.current}, aborting TTS`);
                    return null;
                  }
                  
                  // Check if TTS already started for this turnId (idempotent)
                  if (ttsStartedRef.current.has(turnId)) {
                    console.log(`[TTS] TTS already started for turnId ${turnId}, ignoring duplicate request`);
                    return null;
                  }
                  
                  // Mark TTS as started for this turnId
                  ttsStartedRef.current.add(turnId);
                  console.log(`[TTS] TTS_STARTED ${turnId}`);
                  
                  try {
                    // Use the same high-quality TTS as greeting (gpt-4o-mini-tts)
                    const r = await fetch("/api/tts", { 
                      method: "POST", 
                      headers: { "Content-Type": "application/json" }, 
                      body: JSON.stringify({ 
                        text: reply,
                        voice: "alloy", // Consistent voice
                        format: "mp3" // High-quality format
                      }) 
                    });
                    if (r.ok) { 
                      const j = await r.json(); 
                      console.log("[TTS] Generated high-quality audio for AI response:", j.url);
                      return j.url;
                    } else {
                      console.warn("[TTS] High-quality TTS failed:", r.status);
                    }
                  } catch (e) {
                    console.warn("[TTS] Error generating audio:", e);
                  }
                  return null;
                })();
                
                // Store pending TTS for potential cancellation
                pendingTtsRef.current = null; // No cancel function for audio element approach
                
                // Stop agent recorder and prefer per-turn object URL over stub
                try { agentRecRef.current?.stop(); } catch {}
                try {
                  const recorded = (await agentRecDoneRef.current) ?? null;
                  if (!aurl && recorded) aurl = recorded; // ← only fallback when no TTS URL
                } catch {}
                agentRecRef.current = null;
                agentRecDoneRef.current = null;
                
                // Wait for TTS to complete
                aurl = await ttsPromise;
                
                // Check if turn was superseded during TTS generation
                if (currentTurnIdRef.current !== turnId) {
                  console.log(`[AI] AI_DROPPED ${turnId} (superseded by ${currentTurnIdRef.current})`);
                  return;
                }
                
                if (aurl) {
                  // Final check if turn is still active before pushing and playing
                  if (currentTurnIdRef.current !== turnId) {
                    console.log(`[AI] AI_DROPPED ${turnId} (superseded by ${currentTurnIdRef.current})`);
                    return;
                  }
                  
                  pushTurn("agent", reply, { audioUrl: useTtsStub ? aurl : undefined });
                  console.log("[Turn:assistant]", { text: reply.slice(0,40), audioUrl: aurl });
                  
                  // Play the AI response immediately with high-quality settings
                  if (aurl) {
                    try {
                      // Enter AI playing state
                      enterAIPlaying();
                      
                      // Use dedicated audio element for AI response with high-quality settings
                      const timestamp = Date.now();
                      console.log("[LiveCall] Creating audio element for AI response");
                      const aiResponseEl = await ensureAudioEl(`aiResponse_${timestamp}`, { 
                        volume: 0.7, 
                        routeToDevice: 'none' // Don't try to route to specific device
                      });
                      console.log("[LiveCall] Audio element created:", aiResponseEl);
                      console.log("[LiveCall] Audio element id:", aiResponseEl.id);
                      console.log("[LiveCall] Audio element readyState:", aiResponseEl.readyState);
                      
                      // Ensure audio context is resumed before playing
                      try {
                        const audioContext = audioManager.getAudioContext();
                        if (audioContext && audioContext.state === 'suspended') {
                          await audioContext.resume();
                          console.log("[LiveCall] AudioContext resumed before playback");
                        }
                      } catch (e) {
                        console.warn("[LiveCall] Failed to resume AudioContext:", e);
                      }
                      
                      // Wait for audio element to be ready with better error handling
                      if (aiResponseEl.readyState === 0) {
                        console.log("[LiveCall] Waiting for audio element to be ready...");
                        await new Promise<void>((resolve) => {
                          const onCanPlay = () => {
                            aiResponseEl.removeEventListener('canplay', onCanPlay);
                            aiResponseEl.removeEventListener('error', onError);
                            console.log("[LiveCall] Audio element ready, readyState:", aiResponseEl.readyState);
                            resolve();
                          };
                          
                          const onError = (e: Event) => {
                            aiResponseEl.removeEventListener('canplay', onCanPlay);
                            aiResponseEl.removeEventListener('error', onError);
                            console.warn("[LiveCall] Audio element error during loading:", e);
                            resolve(); // Resolve anyway to continue
                          };
                          
                          aiResponseEl.addEventListener('canplay', onCanPlay);
                          aiResponseEl.addEventListener('error', onError);
                          
                          // Timeout after 3 seconds (increased from 2)
                          setTimeout(() => {
                            aiResponseEl.removeEventListener('canplay', onCanPlay);
                            aiResponseEl.removeEventListener('error', onError);
                            console.log("[LiveCall] Audio element ready timeout, proceeding anyway");
                            resolve();
                          }, 3000);
                        });
                      }
                      
                      // Store reference for barge-in cancellation
                      currentAIAudioRef.current = aiResponseEl;
                      
                      // Set src after sinkId has been configured
                      console.log("[LiveCall] Setting audio src:", aurl);
                      aiResponseEl.src = aurl;
                      console.log("[LiveCall] Audio src set:", aiResponseEl.src);
                      
                      // Ensure the audio element is properly configured
                      aiResponseEl.preload = "auto";
                      aiResponseEl.volume = 0.7;
                      console.log("[LiveCall] Audio element configured - preload:", aiResponseEl.preload, "volume:", aiResponseEl.volume);
                      
                      // Set up event listener to handle when AI audio ends
                      const handleResponseEnd = () => {
                        aiResponseEl.removeEventListener('ended', handleResponseEnd);
                        // Clean up AI analyzer
                        aiAnalyserRef.current = null;
                        aiSourceRef.current = null;
                        // Clear current AI audio reference
                        currentAIAudioRef.current = null;
                        // Exit AI playing state
                        exitAIPlaying();
                        // Remove the audio element to prevent memory leaks
                        try {
                          if (aiResponseEl.parentNode) {
                            aiResponseEl.parentNode.removeChild(aiResponseEl);
                          }
                        } catch (e) {
                          console.warn("[Cleanup] Failed to remove audio element:", e);
                        }
                      };
                      aiResponseEl.addEventListener('ended', handleResponseEnd);
                      
                      // Setup AI analyzer for echo suppression AFTER audio element is ready
                      // Wait for the audio to be loaded before setting up analyzer
                      const setupAnalyzerAfterLoad = () => {
                        if (aiResponseEl.readyState >= 2) { // HAVE_CURRENT_DATA or higher
                          setupAIAnalyzer(aiResponseEl);
                          aiResponseEl.removeEventListener('loadeddata', setupAnalyzerAfterLoad);
                        }
                      };
                      aiResponseEl.addEventListener('loadeddata', setupAnalyzerAfterLoad);
                      
                      // Also try to setup immediately if already loaded
                      if (aiResponseEl.readyState >= 2) {
                        setupAIAnalyzer(aiResponseEl);
                      }
                      
                      console.log("[LiveCall] Attempting to play AI response:", aurl);
                      console.log("[LiveCall] Audio element readyState:", aiResponseEl.readyState);
                      console.log("[LiveCall] Audio element paused:", aiResponseEl.paused);
                      console.log("[LiveCall] Audio element src:", aiResponseEl.src);
                      
                      try {
                        // Ensure the audio element is not paused and has a valid src
                        if (aiResponseEl.paused && aiResponseEl.src) {
                          console.log("[LiveCall] Audio element is paused, attempting to play...");
                          await aiResponseEl.play();
                          console.log("[LiveCall] Successfully started playing AI response:", aurl);
                        } else {
                          console.log("[LiveCall] Audio element already playing or no src");
                        }
                      } catch (playError) {
                        console.error("[LiveCall] Failed to play audio:", playError);
                        console.error("[LiveCall] Audio element state - paused:", aiResponseEl.paused, "readyState:", aiResponseEl.readyState, "src:", aiResponseEl.src);
                        throw playError;
                      }
                    } catch (e) {
                      console.warn("[LiveCall] Failed to play AI response:", e);
                      // Exit AI playing state on error
                      exitAIPlaying();
                    }
                  }
                } else {
                  console.warn("No TTS or recording available — skipping agent audio for this turn");
                }
              }
            }
          });
          
          // Assign to speechRef for compatibility
          speechRef.current = speechInstanceRef.current;
          console.log("[Speech] Speech recognition instance created:", !!speechRef.current);
        }
        
        // Speech recognition will be started by the state machine after AI greeting ends
      }
    });
    
    // Clear loading state
    setIsInitializing(false);
  }

  async function handleEnd() {
    // Clean up subscriptions
    try { unsubRef.current?.(); } catch {}
    unsubRef.current = null;
    
    // Stop all recorders
    try { userRecRef.current?.stop(); } catch {}
    try { agentRecRef.current?.stop(); } catch {}
    userRecRef.current = null;
    agentRecRef.current = null;
    userRecDoneRef.current = null;
    agentRecDoneRef.current = null;
    
    // Stop speech and mic
    try { speechRef.current?.stop(); } catch {}
    try { speechInstanceRef.current?.stop(); } catch {}
    speechInstanceRef.current = null;
    try {
      if (isRecording) {
        setIsRecording(false);
        // Note: Recording functionality not implemented in MicrophoneManager
      }
    } catch {}
    // Don't stop mic here - only during final teardown
    // mic.stop();
    
    // End LiveKit call
    await endLiveKitCall();
    stopSpeaking();
    
    // Force stop all audio elements
    const audioElements = document.querySelectorAll('audio');
    audioElements.forEach(audio => {
      try {
        audio.pause();
        audio.currentTime = 0;
        audio.src = '';
      } catch (e) {
        console.warn("[EndCall] Failed to stop audio element:", e);
      }
    });
    
    // Reset state
    const m = machineRef.current;
    m?.end();
    setVoiceConnected(false);
    voiceConnectedRef.current = false;
    greetedRef.current = false;
    agentSpeakingRef.current = false;
    isCallActiveRef.current = false; // Reset hot-reload protection
    
    // Build minimal CallReview and persist to localStorage under "calls"
    type AgentTurn = { role: "user" | "agent"; text: string; ts: number; audioUrl?: string };
    type CallReview = {
      id: string;
      scenarioId: string | null;
      startedAt: number;
      endedAt: number;
      durationSec: number;
      turns: AgentTurn[];
      audioUrl?: string;
      wpm?: number;
      interruptions?: number;
    };

    const id = callIdRef.current || crypto.randomUUID();
    const startedAt = startedAtRef.current || Date.now();
    const endedAt = Date.now();
    const durationSec = Math.max(0, Math.round((endedAt - startedAt) / 1000));
    const turnsForReview: AgentTurn[] = historyRef.current.map(t => ({
      role: t.role,
      text: t.text,
      ts: startedAt + t.at,
      audioUrl: (t as any).audioUrl ?? null,
    }));
    const call: CallReview = {
      id,
      scenarioId: currentScenario?.id ?? null,
      startedAt,
      endedAt,
      durationSec,
      turns: turnsForReview,
      audioUrl: audioUrl || undefined,
    };
    try {
      // Persist in localStorage (legacy) and also POST to file API
      const key = "calls";
      const list = JSON.parse(localStorage.getItem(key) || "[]") as CallReview[];
      const dedup = list.filter(c => c.id !== call.id);
      dedup.unshift(call);
      localStorage.setItem(key, JSON.stringify(dedup));
      await fetch(`/api/reviews/${id}`, { method: 'POST', body: JSON.stringify(call), headers: { 'Content-Type': 'application/json' } });
      console.log("[ReviewSaved]", call.id, call.turns.map(t => ({ role: t.role, hasUrl: !!(t as any).audioUrl })));
    } catch (e) { console.error("[EndCall] persist failed", e); }
    
    // Clean up all audio and speech before navigating
    console.log("[EndCall] Cleaning up before navigation...");
    cleanup(); // Use the centralized cleanup function
    
    try {
      // Stop mic service (final teardown)
      try {
        await mic.stop(true);
        setMicStream(null);
      } catch (e) {
        console.warn("[EndCall] Failed to stop mic:", e);
      }
      
      // Clear recorder references
      userRecRef.current = null;
      agentRecDoneRef.current = null;
      agentRecRef.current = null;
      agentRecDoneRef.current = null;
      
      // Disconnect from LiveKit
      if (roomRef.current) {
        await roomRef.current.disconnect();
        roomRef.current = null;
      }
      
      console.log("[EndCall] Cleanup complete");
    } catch (e) {
      console.warn("[EndCall] Cleanup error:", e);
    }
  
    console.log("[EndCall] Navigating to review page:", `/review?id=${id}`);
    try {
      await router.push(`/review?id=${id}`);
      console.log("[EndCall] Navigation successful");
    } catch (e) {
      console.error("[EndCall] Navigation failed:", e);
      // Fallback: try to navigate manually
      window.location.href = `/review?id=${id}`;
    }
  }

  // Expose barge-in state for health monitoring
  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as any).__BARGE_STATE__ = {
        aiPlaying: aiPlayingRef.current,
        ttsPlaying: ttsPlayingRef.current,
        bargeEnabled: bargeEnabledRef.current,
        bargeActive: bargeActiveRef.current
      };
    }
  }, [aiPlayingRef.current, ttsPlayingRef.current, bargeEnabledRef.current, bargeActiveRef.current]);

  return (
    <main className="min-h-screen bg-gray-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold text-gray-900">Session: {modeLabel} Mode</h1>
              <span className={`rounded-full px-2 py-0.5 text-[10px] ${isMock ? "bg-blue-50 text-blue-700" : "bg-gray-100 text-gray-700"}`}>
                Mock: {isMock ? "On" : "Off"}
              </span>
              {showChat && (
                <span className="rounded-full px-2 py-0.5 text-[10px] bg-green-50 text-green-700">
                  Chat: On
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-gray-600">
              {currentScenario?.persona || "Sales Agent"} • {currentScenario?.topic || "General"}
            </p>
          </div>
          <div className="flex items-center gap-4">
            <BudgetBadge />
            <DebugToggle
              onChange={setShowChat}
            />
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <ScenarioPicker value={scenarioId} onChange={(id) => router.push(`/session?scenario=${id}&mode=${modeRaw}&mock=${isMock ? "1" : "0"}`)} />
            <div className="flex items-center gap-2">
              <button
                onClick={async () => {
                  if (isToggling) return; // Prevent multiple clicks
                  
                  setIsToggling(true);
                  const newMockValue = !isMock;
                  
                  // Check budget before allowing live mode
                  if (!newMockValue) { // Switching to live mode
                    try {
                      const resp = await fetch("/api/budget");
                      const data = await resp.json();
                      if (data && data.allowed === false) {
                        console.log("[Toggle] Budget cap reached, keeping mock mode ON");
                        alert("Budget cap reached. Please stay in mock mode or contact support.");
                        setIsToggling(false);
                        return; // Keep mock ON
                      }
                    } catch (e) {
                      console.warn("[Toggle] Failed to check budget, allowing live mode");
                    }
                  }
                  
                  setIsMock(newMockValue);
                  // Update URL to persist the change
                  const params = new URLSearchParams(searchParams.toString());
                  params.set("mock", newMockValue ? "1" : "0");
                  router.replace(`${pathname}?${params.toString()}`, { scroll: false });
                  console.log(`[Toggle] Switching from ${isMock ? 'mock' : 'live'} to ${newMockValue ? 'mock' : 'live'} mode`);
                  setIsToggling(false);
                }}
                disabled={isToggling}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  isToggling
                    ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                    : isMock
                    ? "bg-blue-100 text-blue-700 hover:bg-blue-200"
                    : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                }`}
              >
                {isToggling ? "Switching..." : `Mock: ${isMock ? "On" : "Off"}`}
              </button>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-6">
          <CallBar
            state={voiceConnected ? "connected" : "idle"}
            onCall={handleCall}
            onEnd={handleEnd}
            stream={micStream}
            isInitializing={isInitializing}
          />

          {showChat && (
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <ChatWindowClient
                visible={showChat}
                isMock={isMock}
                voiceConnected={voiceConnected}
                callActive={voiceConnected}
                externalTurn={externalTurn}
                onUserUtterance={handleChatUserUtterance}
              />
            </div>
          )}

          {/* Audio Device Settings */}
          {showChat && (
            <AudioDeviceSelector />
          )}

          {/* Text Chat Mirror for Live Mode */}
          {!isMock && voiceConnected && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
              <h3 className="text-sm font-medium text-blue-900 mb-2">Live Chat Mirror</h3>
              
              {/* User Finals */}
              {asrFinals.length > 0 && (
                <div className="mb-3">
                  <div className="text-xs text-blue-700 mb-1">User:</div>
                  <div className="space-y-1">
                    {asrFinals.slice(-3).map((text, i) => (
                      <div key={i} className="text-sm text-blue-800 bg-white p-2 rounded border">
                        {text}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              {/* Echo Gate Messages */}
              {droppedItems.filter(item => item.reason === "echo_gate").length > 0 && (
                <div className="mb-3">
                  <div className="text-xs text-gray-600 italic">
                    (voice ignored—sounded like echo)
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

export default function SessionPage() {
  return (
    <ClientOnly>
      <Suspense fallback={<div>Loading...</div>}>
        <SessionInner />
      </Suspense>
    </ClientOnly>
  );
}


