// CloserCoach-style speech recognition with continuous ASR + VAD gates
// One recognizer instance kept warm, auto-restarting around TTS
import { logInfo, logDebug, logError, logWarn } from "@/lib/logger";
import { sendMessage } from "@/lib/messageDispatcher";

export interface EnhancedSpeechControls {
  start: () => void;
  stop: () => void;
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

// CloserCoach-style configuration
const QUIET_GATE_MS = 75; // Post-TTS quiet gate (75-100ms)
const MIN_CONFIDENCE = 0.82; // Base confidence gate
const MIN_CONFIDENCE_BARGE = 0.75; // Lower confidence for barge-in
const MIN_DURATION_DROP = 250; // Only drop if both low confidence AND short duration
const HEALTH_LOG_INTERVAL = 5000; // Health check interval

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

export function createEnhancedSpeech(handlers: Handlers): EnhancedSpeechControls | null {
  if (typeof window === "undefined") return null;
  const SR: any = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
  if (!SR) return null;
  
  // Single recognizer instance kept warm
  let rec: any = null;
  let isRunning = false; // New: tracks if recognition is actually running
  let active = false;
  let starting = false;
  let requestedStop = false; // New: internal flag for requested stops
  let endedExternally = false;
  let restartCooldown = false;
  let restartCooldownTimer: NodeJS.Timeout | null = null;
  
  // VAD state management
  let isInQuietGate = false;
  let quietGateTimer: NodeJS.Timeout | null = null;
  
  // Speech state
  let ttsPlaying = false;
  let isGating = false; // Whether ASR is currently gated due to TTS
  
  // Interim text buffer for continuous ASR
  let interimBuffer = '';
  
  // Duplicate suppression
  const recentUtterances = new Map<string, number>(); // hash -> timestamp
  
  // Health monitoring
  let lastHealthLog = 0;
  
  // Create recognizer instance
  function createRecognizer() {
    if (rec) return;
    
    rec = new SR();
    rec.continuous = true; // Keep running
    rec.interimResults = true; // Get interim results
    rec.maxAlternatives = 1;
    
    // Configure for optimal performance - wrap grammars in try/catch
    if (rec.grammars) {
      try {
        // Only set grammars if we have a real SpeechGrammarList
        // For now, leave it as null to use default grammar
        rec.grammars = null;
      } catch (error) {
        logDebug('[EnhancedSpeech] Grammars not supported, using default');
        // Continue without grammars - this is fine
      }
    }
    
    logInfo('[EnhancedSpeech] Created recognizer instance');
  }
  
  // Start recognition (only if not already running)
  async function startRecognition() {
    if (isRunning || starting || restartCooldown) {
      logDebug('[EnhancedSpeech] Recognition already running, starting, or in cooldown');
      return;
    }
    
    starting = true;
    requestedStop = false; // Clear stop flag when starting
    
    try {
      createRecognizer();
      
      rec.onstart = () => {
        isRunning = true;
        active = true;
        starting = false;
        endedExternally = false;
        logInfo('[EnhancedSpeech] Recognition started');
        handlers.onSpeechStart?.();
      };
      
      rec.onend = () => {
        isRunning = false;
        active = false;
        starting = false;
        logInfo('[EnhancedSpeech] Recognition ended');
        
        // Clear interim buffer on end
        interimBuffer = '';
        
        // Only auto-restart if not ended externally, not in cooldown, and not requested stop
        if (!endedExternally && !restartCooldown && !requestedStop && !ttsPlaying) {
          logInfo('[EnhancedSpeech] Auto-restarting recognition (not during TTS)');
          setTimeout(() => {
            if (!endedExternally && !restartCooldown && !requestedStop && !ttsPlaying) {
              startRecognition();
            }
          }, 100);
        }
      };
      
      rec.onerror = (event: any) => {
        starting = false;
        
        // Handle specific errors
        if (event.error === 'aborted') {
          // Don't restart immediately on abort - let onend handle it
          logInfo('[EnhancedSpeech] Recognition aborted - will restart if needed');
        } else if (event.error === 'InvalidStateError') {
          // Ignore InvalidStateError - recognition is already in the desired state
          logDebug('[EnhancedSpeech] Ignoring InvalidStateError - recognition already in desired state');
        } else {
          // Log other errors as warnings
          logWarn(`[EnhancedSpeech] Recognition error: ${event.error}`);
          
          if (event.error === 'network') {
            // Network errors get a longer cooldown
            setRestartCooldown(1000);
          } else {
            // Other errors get a short cooldown
            setRestartCooldown(250);
          }
        }
      };
      
      rec.onresult = (event: any) => {
        if (!event.results) return;
        
        const result = event.results[event.results.length - 1];
        const transcript = result[0]?.transcript?.trim();
        const confidence = result[0]?.confidence || 0;
        const isFinal = result.isFinal;
        
        if (!transcript) return;
        
        // Handle interim results - buffer them
        if (!isFinal) {
          interimBuffer = transcript;
          // Only emit interim when not in TTS or quiet gate
          if (!ttsPlaying && !isInQuietGate) {
            handlers.onInterim?.(transcript);
          }
          return;
        }
        
        // Handle final results
        processFinalResult(transcript, confidence);
        // Clear interim buffer after final result
        interimBuffer = '';
      };
      
      try {
        rec.start();
      } catch (error: any) {
        starting = false;
        if (error.name === 'InvalidStateError') {
          // Ignore InvalidStateError - recognition is already in the desired state
          logDebug('[EnhancedSpeech] Ignoring InvalidStateError - recognition already in desired state');
        } else {
          throw error;
        }
      }
      
    } catch (error) {
      starting = false;
      logError('[EnhancedSpeech] Failed to start recognition:', error);
      setRestartCooldown(500);
    }
  }
  
  // Set restart cooldown
  function setRestartCooldown(duration: number) {
    restartCooldown = true;
    if (restartCooldownTimer) {
      clearTimeout(restartCooldownTimer);
    }
    restartCooldownTimer = setTimeout(() => {
      restartCooldown = false;
      restartCooldownTimer = null;
    }, duration);
  }
  
  // Process final speech result
  function processFinalResult(transcript: string, confidence: number) {
    const now = Date.now();
    const duration = 0; // We'll calculate this if needed
    
    // Skip if in quiet gate
    if (isInQuietGate) {
      logDebug('[EnhancedSpeech] Dropping result in quiet gate');
      return;
    }
    
    // Skip if too short and low confidence
    if (duration < MIN_DURATION_DROP && confidence < MIN_CONFIDENCE) {
      logDebug(`[EnhancedSpeech] Dropping short/low-confidence: "${transcript}" (${duration}ms, ${confidence.toFixed(2)})`);
      handlers.onLowConfidence?.(transcript, confidence);
      return;
    }
    
    // Apply confidence boost for domain keywords
    const boostedConfidence = calculateBoostedConfidence(transcript, confidence);
    
    // Check confidence threshold (lower for barge-in)
    const minConf = ttsPlaying ? MIN_CONFIDENCE_BARGE : MIN_CONFIDENCE;
    if (boostedConfidence < minConf) {
      logDebug(`[EnhancedSpeech] Low confidence: "${transcript}" (${boostedConfidence.toFixed(2)} < ${minConf})`);
      handlers.onLowConfidence?.(transcript, boostedConfidence);
      return;
    }
    
    // Skip meta phrases
    if (isMetaPhrase(transcript)) {
      logDebug(`[EnhancedSpeech] Dropping meta phrase: "${transcript}"`);
      return;
    }
    
    // Check for duplicates
    const hash = transcript.toLowerCase().trim();
    const lastTime = recentUtterances.get(hash);
    if (lastTime && (now - lastTime) < 2000) {
      logDebug(`[EnhancedSpeech] Dropping duplicate: "${transcript}"`);
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
    logInfo(`[EnhancedSpeech] Final: "${transcript}" (conf=${boostedConfidence.toFixed(2)}, dur=${duration}ms)`);
    
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
    logDebug(`[EnhancedSpeech] TTS playing: ${playing}, gating: ${isGating}`);
  }
  
  // Start quiet gate (post-TTS)
  function startQuietGate() {
    if (isInQuietGate) return;
    
    isInQuietGate = true;
    logDebug('[EnhancedSpeech] Starting quiet gate');
    
    if (quietGateTimer) {
      clearTimeout(quietGateTimer);
    }
    
    quietGateTimer = setTimeout(() => {
      isInQuietGate = false;
      quietGateTimer = null;
      logDebug('[EnhancedSpeech] Quiet gate ended');
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
    logDebug('[EnhancedSpeech] Quiet gate cancelled');
  }
  
  // Stop recognition
  function stopRecognition() {
    endedExternally = true;
    requestedStop = true; // Set internal stop flag
    
    if (rec && isRunning) {
      try {
        rec.stop();
      } catch (error) {
        logWarn('[EnhancedSpeech] Error stopping recognition:', error);
      }
    }
    
    active = false;
    logInfo('[EnhancedSpeech] Recognition stopped externally');
  }
  
  // Health monitoring
  function startHealthMonitoring() {
    const healthTimer = setInterval(() => {
      const now = Date.now();
      if (now - lastHealthLog >= HEALTH_LOG_INTERVAL) {
        logHealth();
        lastHealthLog = now;
      }
    }, 1000);
  }
  
  function logHealth() {
    const health = {
      recognizer: isRunning,
      listeners: !!rec,
      mic_live: true, // Assuming mic is live if we're here
      tts_playing: ttsPlaying,
      barge_enabled: ttsPlaying,
      gating: isGating,
      recording: active,
      quiet_gate: isInQuietGate,
      commit_window: false
    };
    
    logDebug('[EnhancedSpeech Health]', health);
  }
  
  // Start health monitoring
  startHealthMonitoring();
  
  return {
    start: startRecognition,
    stop: stopRecognition,
    isRunning: () => isRunning, // New: getter for isRunning state
    isActive: () => active,
    startQuietGate,
    cancelQuietGate,
    setTTSPlaying: setTTSPlayingState,
    getHealthStatus: () => ({
      recognizer: isRunning,
      listeners: !!rec,
      mic_live: true,
      tts_playing: ttsPlaying,
      barge_enabled: ttsPlaying,
      gating: isGating,
      recording: active,
      quiet_gate: isInQuietGate,
      commit_window: false
    })
  };
}
