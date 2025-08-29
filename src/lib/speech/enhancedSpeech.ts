// CloserCoach-style speech recognition with continuous ASR + VAD gates
// One recognizer instance kept warm, no auto-restart loops
import { logInfo, logDebug, logThrottled, logChange } from "@/lib/logger";
import { sendMessage } from "@/lib/messageDispatcher";

export interface EnhancedSpeechControls {
  start: () => void;
  stop: () => void;
  isActive: () => boolean;
  startQuietGate: () => void;
  cancelQuietGate: () => void;
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
const VAD_WINDOW_MS = 120; // VAD window (120-150ms)
const EOS_DEBOUNCE_MS = 250; // End-of-speech debounce (250-300ms)
const COMMIT_WINDOW_MS = 200; // Commit window to absorb add-ons
const DUP_SUPPRESS_MS = 2000; // Duplicate suppression window
const MIN_UTTERANCE_WORDS = 1; // Allow one-word turns
const MIN_UTTERANCE_MS = 120; // Minimum voiced audio duration
const MIN_CONFIDENCE = 0.82; // Base confidence gate
const MIN_CONFIDENCE_BARGE = 0.75; // Lower confidence for barge-in
const MIN_DURATION_DROP = 250; // Only drop if both low confidence AND short duration
const HEALTH_LOG_INTERVAL = 5000; // Health check interval

// Barge-in configuration
const BARGE_IN_RMS_THRESHOLD = 30; // Human speech RMS threshold
const BARGE_IN_DURATION_MS = 120; // Duration to detect barge-in
const BARGE_IN_AI_RATIO = 1.5; // Human RMS must be > AI RMS * this ratio
const BARGE_IN_WINDOW_MS = 25; // RMS monitoring window

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
  let active = false;
  let endedExternally = false;
  
  // VAD state management
  let isInQuietGate = false;
  let isInCommitWindow = false;
  let quietGateTimer: NodeJS.Timeout | null = null;
  let commitWindowTimer: NodeJS.Timeout | null = null;
  let eosDebounceTimer: NodeJS.Timeout | null = null;
  
  // Speech state
  let speechStartTime = 0;
  let lastSpeechEndTime = 0;
  let pendingUtterance = "";
  let pendingConfidence = 0;
  let pendingStartTime = 0;
  
  // Barge-in state
  let bargeInDetected = false;
  let bargeInStartTime = 0;
  
  // Duplicate suppression
  const recentUtterances = new Map<string, number>(); // hash -> timestamp
  
  // Health monitoring
  let healthTimer: NodeJS.Timeout | null = null;
  let isRecording = false;
  let isGating = false;
  let micTrackLive = false;
  let ttsPlaying = false;
  let bargeEnabled = false;
  
  // Start health monitoring
  function startHealthMonitoring() {
    if (healthTimer) {
      clearInterval(healthTimer);
    }
    
    healthTimer = setInterval(() => {
      // Get current barge-in state from session (if available)
      const bargeState = {
        aiPlaying: false,
        ttsPlaying: false,
        bargeEnabled: false,
        bargeActive: false
      };
      
      // Try to get state from session if available
      if (typeof window !== 'undefined' && (window as any).__BARGE_STATE__) {
        Object.assign(bargeState, (window as any).__BARGE_STATE__);
      }
      
      console.log(`[HEALTH] recognizer:${active}, listeners:${!!rec}, mic_live:${micTrackLive}, tts_playing:${bargeState.ttsPlaying}, barge_enabled:${bargeState.bargeEnabled}, gating:${isGating}, recording:${isRecording}, quiet_gate:${isInQuietGate}, commit_window:${isInCommitWindow}`);
    }, HEALTH_LOG_INTERVAL);
  }
  
  // Stop health monitoring
  function stopHealthMonitoring() {
    if (healthTimer) {
      clearInterval(healthTimer);
      healthTimer = null;
    }
  }
  
  // Normalize transcript for duplicate detection and meta filtering
  function normalizeTranscript(text: string): string {
    return text
      .toLowerCase()
      .replace(/\b(uh|um|hey|so|well|like|you know)\b/g, '') // Remove fillers
      .replace(/[^\w\s]/g, '') // Remove punctuation
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();
  }

  // Check if text is only meta/filler content
  function isMetaOnly(text: string): boolean {
    const normalized = normalizeTranscript(text);
    const words = normalized.split(/\s+/).filter(Boolean);
    
    // If no words after normalization, it's meta
    if (words.length === 0) return true;
    
    // Check if all words are meta phrases
    const allMeta = words.every(word => META_PHRASES.includes(word));
    
    if (allMeta) {
      console.log(`[INTENT_META_DROP] "${text}"`);
    }
    
    return allMeta;
  }

  // Boost confidence for domain keywords
  function boostConfidenceForKeywords(text: string, confidence: number): number {
    const normalized = text.toLowerCase();
    const words = normalized.split(/\s+/).filter(Boolean);
    
    // Count domain keywords in the utterance
    const keywordCount = words.filter(word => DOMAIN_KEYWORDS.includes(word)).length;
    
    if (keywordCount > 0) {
      const boost = Math.min(0.1 * keywordCount, 0.2); // Max 0.2 boost
      const boostedConfidence = Math.min(confidence + boost, 1.0);
      console.log(`[BOOST] Found ${keywordCount} domain keywords, boosting confidence from ${confidence.toFixed(2)} to ${boostedConfidence.toFixed(2)}`);
      return boostedConfidence;
    }
    
    return confidence;
  }

  // Check if utterance passes gates - only drop if both low confidence AND short duration
  function passesUtteranceGates(text: string, confidence: number, duration: number): boolean {
    // Apply domain keyword confidence boost
    const boostedConfidence = boostConfidenceForKeywords(text, confidence);
    
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const lengthOk = wordCount >= MIN_UTTERANCE_WORDS || duration >= MIN_UTTERANCE_MS;
    const confidenceOk = boostedConfidence >= MIN_CONFIDENCE;
    
    // Only drop if BOTH low confidence AND short duration
    const shouldDrop = boostedConfidence < MIN_CONFIDENCE_BARGE && duration < MIN_DURATION_DROP;
    
    console.log(`[GATES] words:${wordCount}, conf:${confidence.toFixed(2)}->${boostedConfidence.toFixed(2)}, durMs:${duration}, lengthOk:${lengthOk}, confOk:${confidenceOk}, shouldDrop:${shouldDrop}`);
    
    return !shouldDrop && (lengthOk || confidenceOk);
  }

  // Check for duplicate suppression
  function isDuplicate(text: string): boolean {
    const normalized = normalizeTranscript(text);
    const now = Date.now();
    
    // Clean old entries
    for (const [hash, timestamp] of recentUtterances.entries()) {
      if (now - timestamp > DUP_SUPPRESS_MS) {
        recentUtterances.delete(hash);
      }
    }
    
    if (recentUtterances.has(normalized)) {
      console.log(`[Speech] DUP_SUPPRESS_HIT: "${normalized}"`);
      return true;
    }
    
    recentUtterances.set(normalized, now);
    return false;
  }

  // Process final utterance with gating and commit window
  function processFinalUtterance(text: string, confidence: number, startTime: number) {
    const duration = Date.now() - startTime;
    
    // Log every utterance that passes VAD before any filters
    console.log(`[UTTERANCE] text:"${text}", confidence:${confidence.toFixed(2)}, duration:${duration}ms, dropped:false`);
    
    // Check if text is only meta/filler content (but allow during barge-in)
    if (isMetaOnly(text) && !bargeInDetected) {
      console.log(`[UTTERANCE] text:"${text}", confidence:${confidence.toFixed(2)}, duration:${duration}ms, dropped:true, drop_reason:meta`);
      return;
    }
    
    // If final confidence < 0.75, suggest confirmation instead of guessing
    if (confidence < 0.75) {
      console.log(`[CONFIRM] Low confidence (${confidence.toFixed(2)}) - suggesting confirmation for: "${text}"`);
      handlers.onLowConfidence?.(text, confidence);
      return;
    }
    
    // Check utterance gates
    if (!passesUtteranceGates(text, confidence, duration)) {
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      const lengthOk = wordCount >= MIN_UTTERANCE_WORDS || duration >= MIN_UTTERANCE_MS;
      const confidenceOk = confidence >= MIN_CONFIDENCE;
      
      let dropReason = "";
      if (!lengthOk) {
        dropReason = `gates_length(${wordCount}words/${duration}ms < ${MIN_UTTERANCE_WORDS}words/${MIN_UTTERANCE_MS}ms)`;
      } else if (!confidenceOk) {
        dropReason = `gates_confidence(${confidence.toFixed(2)} < ${MIN_CONFIDENCE})`;
      }
      
      console.log(`[UTTERANCE] text:"${text}", confidence:${confidence.toFixed(2)}, duration:${duration}ms, dropped:true, drop_reason:${dropReason}`);
      console.log(`[Speech] Utterance failed gates, buffering: "${text}"`);
      pendingUtterance = text;
      pendingConfidence = confidence;
      pendingStartTime = startTime;
      return;
    }
    
    // Check duplicate suppression
    if (isDuplicate(text)) {
      console.log(`[UTTERANCE] text:"${text}", confidence:${confidence.toFixed(2)}, duration:${duration}ms, dropped:true, drop_reason:duplicate`);
      console.log(`[Speech] Duplicate utterance suppressed: "${text}"`);
      return;
    }
    
    // Start commit window
    isInCommitWindow = true;
    console.log(`[Speech] Starting commit window for: "${text}"`);
    
    commitWindowTimer = setTimeout(() => {
      isInCommitWindow = false;
      
      // If we have pending utterance, append it
      if (pendingUtterance) {
        const combinedText = `${text} ${pendingUtterance}`.trim();
        const combinedDuration = Date.now() - Math.min(startTime, pendingStartTime);
        
        console.log(`[Speech] Combining with pending: "${combinedText}"`);
        
        // Check if combined utterance passes gates
        if (passesUtteranceGates(combinedText, Math.min(confidence, pendingConfidence), combinedDuration)) {
          handlers.onFinal?.(combinedText);
          
          // Send to message dispatcher for AI processing
          sendMessage(combinedText, {
            source: 'voice',
            confidence: Math.min(confidence, pendingConfidence),
            duration: combinedDuration
          }).catch(error => {
            logError('[Speech] Failed to send combined message to dispatcher', { error, text: combinedText });
          });
        } else {
          console.log(`[Speech] Combined utterance failed gates or is duplicate`);
        }
        
        pendingUtterance = "";
        pendingConfidence = 0;
        pendingStartTime = 0;
      } else {
        // No pending utterance, commit the current one
        handlers.onFinal?.(text);
        
        // Send to message dispatcher for AI processing
        sendMessage(text, {
          source: 'voice',
          confidence,
          duration
        }).catch(error => {
          logError('[Speech] Failed to send message to dispatcher', { error, text });
        });
      }
    }, COMMIT_WINDOW_MS);
  }

  // Create and configure speech recognition (kept warm)
  function createRecognizer() {
    logInfo("[Speech] Creating speech recognizer");
    
    if (rec) {
      try {
        rec.stop();
        logInfo("[Speech] Stopped existing recognizer");
      } catch (e) {
        // Ignore stop errors
      }
    }
    
    try {
      rec = new SR();
      logInfo("[Speech] Speech recognizer created successfully");
    } catch (error) {
      logError("[Speech] Failed to create speech recognizer", { error });
      return;
    }
    
    // CloserCoach-style configuration for continuous ASR
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = 'en-US';
    
    logInfo("[Speech] Speech recognizer configured", {
      continuous: rec.continuous,
      interimResults: rec.interimResults,
      maxAlternatives: rec.maxAlternatives,
      lang: rec.lang
    });
    
    // Enhanced event handling
    rec.onstart = () => {
      active = true;
      isRecording = true;
      logInfo("[Speech] Recognition started");
    };
    
    rec.onend = () => {
      active = false;
      isRecording = false;
      logInfo("[Speech] Recognition ended");
      
      // NO AUTO-RESTART - recognizer stays created and started
      // Only restart if externally ended and not in quiet gate
      if (!endedExternally && !isInQuietGate) {
        console.log("[Speech] Restarting recognition (not in quiet gate)");
        setTimeout(() => {
          if (!endedExternally) {
            rec?.start();
          }
        }, 100);
      }
    };
    
    rec.onerror = (event: any) => {
      console.warn("[Speech] Recognition error:", event.error);
      if (event.error === 'no-speech') {
        // Don't restart on no-speech errors
        return;
      }
      
      // Only restart on non-fatal errors
      if (!endedExternally && event.error !== 'aborted') {
        console.log(`[Speech] Restarting after error: ${event.error}`);
        setTimeout(() => {
          if (!endedExternally) {
            rec?.start();
          }
        }, 100);
      }
    };
    
    rec.onaudiostart = () => {
      micTrackLive = true;
      logInfo("[Speech] Audio started - microphone detected");
    };
    
    rec.onaudioend = () => {
      micTrackLive = false;
      logInfo("[Speech] Audio ended - microphone stopped");
    };
    
    rec.onsoundstart = () => {
      if (speechStartTime === 0) {
        speechStartTime = Date.now();
        console.log("[Speech] Speech started at", speechStartTime);
        
        // Call speech start handler
        handlers.onSpeechStart?.();
        
        // Trigger barge-in callback when speech starts
        // This allows the session to detect when user starts speaking during AI playback
        handlers.onBargeIn?.();
      }
    };
    
    rec.onsoundend = () => {
      lastSpeechEndTime = Date.now();
      console.log("[Speech] Speech ended at", lastSpeechEndTime);
      
      if (eosDebounceTimer) {
        clearTimeout(eosDebounceTimer);
      }
      
      eosDebounceTimer = setTimeout(() => {
        console.log("[Speech] Calling onSpeechEnd handler");
        handlers.onSpeechEnd?.();
        speechStartTime = 0;
      }, EOS_DEBOUNCE_MS);
    };
    
    rec.onresult = (event: any) => {
      let interim = "";
      let final = "";
      
      logInfo("[Speech] onresult called", { 
        resultIndex: event.resultIndex, 
        resultsLength: event.results.length,
        hasResults: event.results.length > 0
      });
      
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          final += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }
      
      // Handle interim results
      if (interim.trim()) {
        logInfo("[Speech] Interim result", { text: interim.trim() });
        handlers.onInterim?.(interim.trim());
      }
      
      // Handle final results
      if (final.trim()) {
        const confidence = event.results[event.results.length - 1][0].confidence || 0.9;
        logInfo("[Speech] Final result", { text: final.trim(), confidence });
        processFinalUtterance(final.trim(), confidence, speechStartTime || Date.now());
      }
    };
  }

  // Start quiet gate (post-TTS)
  function startQuietGate() {
    if (quietGateTimer) {
      clearTimeout(quietGateTimer);
    }
    
    isInQuietGate = true;
    console.log(`[Speech] Starting quiet gate (${QUIET_GATE_MS}ms)`);
    
    quietGateTimer = setTimeout(() => {
      isInQuietGate = false;
      console.log("[Speech] Quiet gate ended");
      
      // Restart recognition after quiet gate only if not already active
      if (!endedExternally && rec && !active) {
        try {
          rec.start();
        } catch (e) {
          console.warn("[Speech] Failed to restart recognition after quiet gate:", e);
          // If restart fails, create a new recognizer
          createRecognizer();
          rec?.start();
        }
      }
    }, QUIET_GATE_MS);
  }
  
  // Cancel quiet gate
  function cancelQuietGate() {
    if (quietGateTimer) {
      clearTimeout(quietGateTimer);
      quietGateTimer = null;
    }
    isInQuietGate = false;
    console.log("[Speech] Quiet gate cancelled");
  }

  return {
    start: async () => {
      endedExternally = false;
      logInfo("[Speech] Starting speech recognition");
      
      // Check microphone permissions first
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        logInfo("[Speech] Microphone permission granted");
        // Stop the stream since we just needed permission
        stream.getTracks().forEach(track => track.stop());
      } catch (error) {
        logError("[Speech] Microphone permission denied", { error });
        return;
      }
      
      createRecognizer();
      if (rec) {
        try {
          rec.start();
          active = true; // Set active immediately when starting
          logInfo("[Speech] Speech recognition started successfully");
        } catch (error) {
          logError("[Speech] Failed to start speech recognition", { error });
        }
      } else {
        logError("[Speech] Failed to create speech recognizer");
      }
      startHealthMonitoring();
    },
    
    stop: () => {
      endedExternally = true;
      active = false; // Set inactive immediately when stopping
      stopHealthMonitoring();
      
      if (rec) {
        try {
          rec.stop();
        } catch (e) {
          console.warn("[Speech] Error stopping recognition:", e);
        }
        rec = null;
      }
      
      // Clear timers
      if (eosDebounceTimer) {
        clearTimeout(eosDebounceTimer);
        eosDebounceTimer = null;
      }
      if (commitWindowTimer) {
        clearTimeout(commitWindowTimer);
        commitWindowTimer = null;
      }
      if (quietGateTimer) {
        clearTimeout(quietGateTimer);
        quietGateTimer = null;
      }
    },
    
    isActive: () => active,
    
    startQuietGate,
    cancelQuietGate,
    
    // Health status
    getHealthStatus: (bargeState?: {
      aiPlaying: boolean;
      ttsPlaying: boolean;
      bargeEnabled: boolean;
      bargeActive: boolean;
    }) => ({
      recognizer: active,
      listeners: !!rec,
      mic_live: micTrackLive,
      tts_playing: bargeState?.ttsPlaying ?? ttsPlaying,
      barge_enabled: bargeState?.bargeEnabled ?? bargeEnabled,
      gating: isGating,
      recording: isRecording,
      quiet_gate: isInQuietGate,
      commit_window: isInCommitWindow
    })
  };
}
