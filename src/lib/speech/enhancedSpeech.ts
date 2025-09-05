// Singleton SpeechRecognition with guarded lifecycle and auto-restart
// Ensures exactly one recognizer instance with proper start/stop management
import { info, debug, error, warn } from "@/lib/logger";
import { sendMessage } from "@/lib/messageDispatcher";

export interface EnhancedSpeechControls {
  startRecognitionLoop: () => void;
  pauseRecognitionLoop: () => void;
  isRunning: () => boolean;
  isActive: () => boolean;
  startQuietGate: () => void;
  cancelQuietGate: () => void;
  setTTSPlaying: (playing: boolean) => void;
  getHealthStatus: () => {
    recognizer: boolean;
    listeners: boolean;
    mic_live: boolean;
    tts_playing: boolean;
    barge_enabled: boolean;
    gating: boolean;
    recording: boolean;
    quiet_gate: boolean;
    commit_window: boolean;
    vad_speaking: boolean;
    vad_speech_duration: number;
  };
}

type Handlers = {
  onInterim?: (text: string) => void;
  onFinal?: (text: string) => void;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onBargeIn?: () => void;
  onLowConfidence?: (text: string, confidence: number) => void;
};

// Configuration
const QUIET_GATE_MS = 75; // Post-TTS quiet gate (75-100ms)
const MIN_CONFIDENCE = 0.82; // Base confidence gate
const MIN_CONFIDENCE_BARGE = 0.75; // Lower confidence for barge-in
const MIN_DURATION_DROP = 250; // Only drop if both low confidence AND short duration
const HEALTH_LOG_INTERVAL = 5000; // Health check interval
const RESTART_DELAY = 150; // Delay before auto-restart

// VAD Configuration - Custom utterance finalization timing
const MIN_SPEECH_MS = 700; // Minimum continuous speech before we consider finalizing
const REQUIRED_SILENCE_MS = 400; // Continuous silence required to finalize (350-500ms range)
const OVERALL_SILENCE_TIMEOUT_MS = 1350; // Fallback finalize if user stops speaking (1200-1500ms range)

// Meta/filler phrases to drop
const META_PHRASES = [
  'hey', 'hello', 'yeah', 'okay', 'ok', 'hold on', 'wait', 'one sec', 'can you hear me',
  'are you listening', 'can i interrupt', 'excuse me', 'sorry', 'um', 'uh', 'so', 'well',
  'you know', 'like', 'basically', 'actually', 'anyway', 'right', 'see', 'look'
];

// Domain keywords for confidence boost (sales/insurance context)
const DOMAIN_KEYWORDS = [
  'renewal', 'bundle', 'policy', 'coverage', 'premium', 'deductible', 'claim', 'agent',
  'quote', 'rate', 'discount', 'savings', 'insurance', 'auto', 'home', 'life', 'health',
  'car', 'house', 'family', 'protection', 'security', 'peace', 'mind', 'affordable',
  'compare', 'switch', 'change', 'cancel', 'start', 'begin', 'help', 'assist', 'support'
];

// Module-scope singleton state
let recognition: SpeechRecognition | null = null;
let recognitionRunning = false;
let wantRecognition = false;
let restartTimer: number | null = null;
let handlers: Handlers = {};

// VAD state management
let isInQuietGate = false;
let quietGateTimer: NodeJS.Timeout | null = null;

// Custom VAD state for utterance finalization
let vadState = {
  isSpeaking: false,
  speechStartTime: 0,
  lastSpeechTime: 0,
  silenceStartTime: 0,
  currentUtterance: '',
  utteranceTimer: null as NodeJS.Timeout | null,
  silenceTimer: null as NodeJS.Timeout | null,
  overallTimer: null as NodeJS.Timeout | null
};

// Speech state
let ttsPlaying = false;
let isGating = false;

// Interim text buffer for continuous ASR (used in onresult)
let interimBuffer = '';

// Duplicate suppression
const recentUtterances = new Map<string, number>(); // hash -> timestamp

// Health monitoring
let lastHealthLog = 0;
// Initialize singleton recognizer
function initRecognizer(): SpeechRecognition | null {
  if (recognition) return recognition;
  
  if (typeof window === "undefined") return null;
  const SR = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
  if (!SR) return null;
  
  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  
  // Configure for optimal performance
  if (recognition.grammars) {
    try {
      recognition.grammars = null; // Use default grammar
    } catch {
      debug('SPEECH', 'Grammars not supported, using default');
    }
  }
  
  // Set up event handlers
  recognition.onstart = () => {
    recognitionRunning = true;
    info('SPEECH', 'Recognition started');
    handlers.onSpeechStart?.();
  };
  
  recognition.onend = () => {
    recognitionRunning = false;
    info('SPEECH', 'Recognition ended');
    
    // Clear interim buffer on end
    interimBuffer = '';
    
    // Reset VAD state on recognition end
    resetVADState();
    
    // Auto-restart if we want recognition and not during TTS
    if (wantRecognition && !ttsPlaying) {
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = window.setTimeout(() => safeStart(), RESTART_DELAY);
    }
  };
  
  recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
    warn('SPEECH', `Recognition error: ${event.error}`);
    
    if (event.error === 'InvalidStateError') {
      // Ignore InvalidStateError - recognition is already in the desired state
      debug('SPEECH', 'Ignoring InvalidStateError - recognition already in desired state');
    } else if (event.error === 'aborted') {
      // Don't restart immediately on abort - let onend handle it
      info('SPEECH', 'Recognition aborted - will restart if needed');
    }
  };
  
  recognition.onresult = (event: SpeechRecognitionEvent) => {
    if (!event.results) return;
    
    const result = event.results[event.results.length - 1];
    const transcript = result[0]?.transcript?.trim();
    const confidence = result[0]?.confidence || 0;
    const isFinal = result.isFinal;
    
    if (!transcript) return;
    
    // Handle interim results - use custom VAD logic
    if (!isFinal) {
      handleInterimResult(transcript, confidence);
      return;
    }
    
    // Handle final results from Web Speech API (but we'll use our own VAD timing)
    handleWebSpeechFinal(transcript, confidence);
  };
  
  info('SPEECH', 'Created singleton recognizer instance');
  return recognition;
}

// Safe start with InvalidStateError handling
function safeStart() {
  if (!wantRecognition || recognitionRunning) return;
  
  try {
    recognition.start();
    recognitionRunning = true;
  } catch (e: unknown) {
    // Handle InvalidStateError by retrying once shortly
    if (e instanceof Error && e.name === 'InvalidStateError') {
      debug('SPEECH', 'InvalidStateError, retrying in 150ms');
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = window.setTimeout(() => safeStart(), 150);
    } else {
      error('SPEECH', 'Failed to start recognition:', e);
    }
  }
}

// Safe stop
function safeStop() {
  wantRecognition = false;
  if (!recognitionRunning) return;
  
  try {
    recognition.stop();
  } catch (e: unknown) {
    warn('SPEECH', 'Error stopping recognition:', e);
  }
  recognitionRunning = false;
}
// Custom VAD Logic Functions

// Handle interim results with custom VAD timing
function handleInterimResult(transcript: string, confidence: number) {
  const now = Date.now();
  
  // Update current utterance
  vadState.currentUtterance = transcript;
  vadState.lastSpeechTime = now;
  
  // If we weren't speaking, start speech detection
  if (!vadState.isSpeaking) {
    vadState.isSpeaking = true;
    vadState.speechStartTime = now;
    debug('SPEECH', 'Speech started - beginning VAD monitoring');
    
    // Start overall timeout timer
    if (vadState.overallTimer) {
      clearTimeout(vadState.overallTimer);
    }
    vadState.overallTimer = setTimeout(() => {
      debug('SPEECH', 'Overall silence timeout reached - finalizing utterance');
      finalizeCurrentUtterance();
    }, OVERALL_SILENCE_TIMEOUT_MS);
  }
  
  // Clear any existing silence timer since we have speech
  if (vadState.silenceTimer) {
    clearTimeout(vadState.silenceTimer);
    vadState.silenceTimer = null;
  }
  
  // Emit interim result if not in TTS or quiet gate
  if (!ttsPlaying && !isInQuietGate) {
    handlers.onInterim?.(transcript);
  }
}

// Handle Web Speech API final results (but use our own timing)
function handleWebSpeechFinal(transcript: string, confidence: number) {
  const now = Date.now();
  
  // Update current utterance with final result
  vadState.currentUtterance = transcript;
  vadState.lastSpeechTime = now;
  
  // If we weren't speaking, start speech detection
  if (!vadState.isSpeaking) {
    vadState.isSpeaking = true;
    vadState.speechStartTime = now;
    debug('SPEECH', 'Speech started (from final result) - beginning VAD monitoring');
    
    // Start overall timeout timer
    if (vadState.overallTimer) {
      clearTimeout(vadState.overallTimer);
    }
    vadState.overallTimer = setTimeout(() => {
      debug('SPEECH', 'Overall silence timeout reached - finalizing utterance');
      finalizeCurrentUtterance();
    }, OVERALL_SILENCE_TIMEOUT_MS);
  }
  
  // Check if we've met minimum speech duration
  const speechDuration = now - vadState.speechStartTime;
  if (speechDuration >= MIN_SPEECH_MS) {
    // Start silence detection timer
    if (vadState.silenceTimer) {
      clearTimeout(vadState.silenceTimer);
    }
    vadState.silenceTimer = setTimeout(() => {
      debug('SPEECH', 'Required silence period reached - finalizing utterance');
      finalizeCurrentUtterance();
    }, REQUIRED_SILENCE_MS);
  } else {
    debug('SPEECH', `Speech duration ${speechDuration}ms < ${MIN_SPEECH_MS}ms - waiting for minimum speech`);
  }
}

// Finalize the current utterance
function finalizeCurrentUtterance() {
  if (!vadState.isSpeaking || !vadState.currentUtterance) {
    return;
  }
  
  const transcript = vadState.currentUtterance;
  const speechDuration = Date.now() - vadState.speechStartTime;
  
  debug('SPEECH', `Finalizing utterance: "${transcript}" (duration: ${speechDuration}ms)`);
  
  // Process the final result
  processFinalResult(transcript, 0.9); // Use high confidence for our VAD-controlled results
  
  // Reset VAD state
  resetVADState();
}

// Reset VAD state
function resetVADState() {
  vadState.isSpeaking = false;
  vadState.speechStartTime = 0;
  vadState.lastSpeechTime = 0;
  vadState.silenceStartTime = 0;
  vadState.currentUtterance = '';
  
  if (vadState.utteranceTimer) {
    clearTimeout(vadState.utteranceTimer);
    vadState.utteranceTimer = null;
  }
  
  if (vadState.silenceTimer) {
    clearTimeout(vadState.silenceTimer);
    vadState.silenceTimer = null;
  }
  
  if (vadState.overallTimer) {
    clearTimeout(vadState.overallTimer);
    vadState.overallTimer = null;
  }
  
  debug('SPEECH', 'VAD state reset');
}

// Process final speech result
function processFinalResult(transcript: string, confidence: number) {
  const now = Date.now();
  const duration = 0; // We'll calculate this if needed
  
  // Skip if in quiet gate
  if (isInQuietGate) {
    debug('SPEECH', 'Dropping result in quiet gate');
    return;
  }
  
  // Skip if too short and low confidence
  if (duration < MIN_DURATION_DROP && confidence < MIN_CONFIDENCE) {
    debug('SPEECH', `Dropping short/low-confidence: "${transcript}" (${duration}ms, ${confidence.toFixed(2)})`);
    handlers.onLowConfidence?.(transcript, confidence);
    return;
  }
  
  // Apply confidence boost for domain keywords
  const boostedConfidence = calculateBoostedConfidence(transcript, confidence);
  
  // Check confidence threshold (lower for barge-in)
  const minConf = ttsPlaying ? MIN_CONFIDENCE_BARGE : MIN_CONFIDENCE;
  if (boostedConfidence < minConf) {
    debug('SPEECH', `Low confidence: "${transcript}" (${boostedConfidence.toFixed(2)} < ${minConf})`);
    handlers.onLowConfidence?.(transcript, boostedConfidence);
    return;
  }
  
  // Skip meta phrases
  if (isMetaPhrase(transcript)) {
    debug('SPEECH', `Dropping meta phrase: "${transcript}"`);
    return;
  }
  
  // Check for duplicates
  const hash = transcript.toLowerCase().trim();
  const lastTime = recentUtterances.get(hash);
  if (lastTime && (now - lastTime) < 2000) {
    debug('SPEECH', `Dropping duplicate: "${transcript}"`);
    return;
  }
  recentUtterances.set(hash, now);
  
  // Clean up old entries
  for (const [key, timestamp] of recentUtterances.entries()) {
    if (now - timestamp > 2000) {
      recentUtterances.delete(key);
    }
  }
  
  // Commit the utterance
  info('SPEECH', `Final: "${transcript}" (conf=${boostedConfidence.toFixed(2)}, dur=${duration}ms)`);
  
  // Send to message dispatcher
  sendMessage({
    text: transcript,
    metadata: {
      source: 'speech',
      confidence: boostedConfidence,
      duration,
      timestamp: now
    }
  });
  
  handlers.onFinal?.(transcript);
}

// Calculate boosted confidence based on domain keywords
function calculateBoostedConfidence(transcript: string, baseConfidence: number): number {
  const words = transcript.toLowerCase().split(/\s+/);
  let boost = 0;
  
  for (const word of words) {
    if (DOMAIN_KEYWORDS.includes(word)) {
      boost += 0.05; // Small boost per domain word
    }
  }
  
  return Math.min(1.0, baseConfidence + boost);
}

// Check if text is a meta phrase
function isMetaPhrase(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return META_PHRASES.some(phrase => lower.includes(phrase));
}

// Set TTS playing state
function setTTSPlayingState(playing: boolean) {
  ttsPlaying = playing;
  isGating = playing;
  debug('SPEECH', `TTS playing: ${playing}, gating: ${isGating}`);
}

// Start quiet gate (post-TTS)
function startQuietGate() {
  if (isInQuietGate) return;
  
  isInQuietGate = true;
  debug('SPEECH', 'Starting quiet gate');
  
  if (quietGateTimer) {
    clearTimeout(quietGateTimer);
  }
  
  quietGateTimer = setTimeout(() => {
    isInQuietGate = false;
    quietGateTimer = null;
    debug('SPEECH', 'Quiet gate ended');
  }, QUIET_GATE_MS);
}

// Cancel quiet gate
function cancelQuietGate() {
  if (!isInQuietGate) return;
  
  isInQuietGate = false;
  if (quietGateTimer) {
    clearTimeout(quietGateTimer);
    quietGateTimer = null;
  }
  debug('SPEECH', 'Quiet gate cancelled');
}

// Health monitoring
function startHealthMonitoring() {
  setInterval(() => {
    const now = Date.now();
    if (now - lastHealthLog >= HEALTH_LOG_INTERVAL) {
      logHealth();
      lastHealthLog = now;
    }
  }, 1000);
}

function logHealth() {
  const health = {
    recognizer: recognitionRunning,
    listeners: !!recognition,
    mic_live: true, // Assuming mic is live if we're here
    tts_playing: ttsPlaying,
    barge_enabled: ttsPlaying,
    gating: isGating,
    recording: recognitionRunning,
    quiet_gate: isInQuietGate,
    commit_window: false
  };
  
  debug('SPEECH-HEALTH', 'Health check', health);
}

// Start health monitoring
startHealthMonitoring();

// Public API functions
export function startRecognitionLoop() {
  wantRecognition = true;
  initRecognizer(); // Ensure recognizer exists
  safeStart();
}

export function pauseRecognitionLoop() {
  safeStop();
}

// Main factory function
export function createEnhancedSpeech(handlersParam: Handlers): EnhancedSpeechControls | null {
  if (typeof window === "undefined") return null;
  
  // Store handlers for the singleton
  handlers = handlersParam;
  
  // Initialize the singleton recognizer
  initRecognizer();
  
  return {
    startRecognitionLoop,
    pauseRecognitionLoop,
    isRunning: () => recognitionRunning,
    isActive: () => recognitionRunning,
    startQuietGate,
    cancelQuietGate,
    setTTSPlaying: setTTSPlayingState,
    getHealthStatus: () => ({
      recognizer: recognitionRunning,
      listeners: !!recognition,
      mic_live: true,
      tts_playing: ttsPlaying,
      barge_enabled: ttsPlaying,
      gating: isGating,
      recording: recognitionRunning,
      quiet_gate: isInQuietGate,
      commit_window: false,
      vad_speaking: vadState.isSpeaking,
      vad_speech_duration: vadState.isSpeaking ? Date.now() - vadState.speechStartTime : 0
    })
  };
}
