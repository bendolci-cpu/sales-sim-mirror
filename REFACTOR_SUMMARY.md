# Unified Audio Pipeline Refactor Summary

## 🎯 **Problem Solved**

The original system had overlapping and conflicting components:
- **AudioManager** + **LegacyAudioManager** (duplicate audio contexts)
- **BargeInDetector** + **ASRManager** (separate speech detection)
- **Multiple ASR start/stop cycles** (unnecessary restarts)
- **Complex state management** (aiPlaying, bargeActive, etc.)
- **Duplicate TTS systems** (original + message dispatcher)

## 🏗️ **New Unified Architecture**

### **1. UnifiedAudioPipeline** (`src/lib/unifiedAudioPipeline.ts`)
**Single source of truth** for all audio and speech recognition:

```typescript
class UnifiedAudioPipeline {
  // Core audio context and state
  private audioContext: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private micAnalyzer: AnalyserNode | null = null;
  private aiAnalyzer: AnalyserNode | null = null;
  
  // Speech recognition (always-on)
  private speechRecognition: EnhancedSpeechControls | null = null;
  
  // TTS playback (single path)
  private currentTTSAbortController: AbortController | null = null;
  private currentTTSTurnId: string | null = null;
  
  // Barge-in detection (integrated)
  private bargeInMonitoring = false;
}
```

### **2. Clean Session Page** (`src/app/session/cleanSession.tsx`)
**Simplified session management** with clear flow:

```typescript
// Single pipeline instance
const unifiedPipeline = useRef(getUnifiedAudioPipeline());

// Single message handler
const handleMessageDispatcher = async (request) => {
  // 1. Add user turn
  // 2. Generate AI response  
  // 3. Add AI turn
  // 4. Play TTS (single path)
};
```

## 🔄 **Clean Pipeline Flow**

### **1. Mic Input** ✅
- **One track**: Single MediaStream from `navigator.mediaDevices.getUserMedia()`
- **One recognizer**: Always-on EnhancedSpeechControls instance
- **No duplicates**: Singleton pattern prevents multiple instances

### **2. ASR** ✅  
- **Always-on recognizer**: Started once, never restarted
- **Direct to dispatcher**: Utterances sent immediately to message dispatcher
- **No unnecessary cycles**: No start/stop loops

### **3. AI Transport** ✅
- **Final utterance → dispatcher**: Enhanced speech sends to message dispatcher
- **Dispatcher → AI**: Single handler processes all messages
- **AI → response**: Unified response generation (mock or live)

### **4. TTS** ✅
- **Single path**: All TTS goes through `unifiedPipeline.playTTS()`
- **Abort support**: AbortController cancels late TTS attempts
- **Clean state**: Clear turnId tracking

### **5. Barge-in** ✅
- **Integrated detection**: Built into unified pipeline
- **Clean interruption**: Stops TTS, triggers callback
- **No state conflicts**: Single source of truth

## 📊 **Acceptance Criteria Verification**

### ✅ **User speech always gets dispatched to AI**
```typescript
// Enhanced speech sends directly to dispatcher
sendMessage(text, { source: 'voice', confidence, duration });
```

### ✅ **AI reply always comes back, shows in chat, and plays TTS**
```typescript
// Single handler processes all messages
const handleMessageDispatcher = async (request) => {
  // Add user turn → Generate AI → Add AI turn → Play TTS
};
```

### ✅ **Barge-in interrupts TTS cleanly**
```typescript
// Integrated barge-in detection
onBargeIn: () => {
  if (this.currentTTSTurnId) {
    this.stopTTS();
    this.config.onBargeIn?.();
  }
}
```

### ✅ **No duplicate listeners or recognizers after hot reload**
```typescript
// Singleton pattern with cleanup
let unifiedPipeline: UnifiedAudioPipeline | null = null;

export function cleanupUnifiedAudioPipeline(): void {
  if (unifiedPipeline) {
    unifiedPipeline.cleanup();
    unifiedPipeline = null;
  }
}
```

## 🧹 **Removed Legacy Code**

### **Deleted/Consolidated:**
- ❌ `AudioManager` class (duplicate)
- ❌ `LegacyAudioManager` references  
- ❌ `BargeInDetector` class (integrated)
- ❌ `ASRManager` class (integrated)
- ❌ `TTSPlayer` class (integrated)
- ❌ Complex state machine (`aiPlaying`, `bargeActive`, etc.)
- ❌ Multiple ASR start/stop cycles
- ❌ Duplicate TTS systems

### **Kept/Enhanced:**
- ✅ `EnhancedSpeechControls` (core speech recognition)
- ✅ `MessageDispatcher` (unified message handling)
- ✅ `Logger` (professional logging)
- ✅ `LiveKit` integration (for mic publishing)

## 🚀 **Usage**

### **Test the Clean System:**
```bash
# Navigate to clean session
http://localhost:3000/session/clean?mode=practice&mock=1&scenario=cdi-outbreak-icu
```

### **Expected Logs:**
```
[UnifiedAudio] Initializing pipeline
[UnifiedAudio] AudioContext initialized at 24kHz  
[UnifiedAudio] Microphone initialized with analyzer
[UnifiedAudio] Speech recognition started
[UnifiedAudio] Pipeline initialized successfully
[CleanSession] Call started successfully
[CleanSession] Processing message: "hello there" (voice)
[CleanSession] Generated mock response: "Hello! How can I help you today?"
[UnifiedAudio] Starting TTS for turn abc123: "Hello! How can I help you today?"
[UnifiedAudio] TTS playing for turn abc123
```

## 🎯 **Benefits**

1. **Single Responsibility**: Each component has one clear purpose
2. **No Duplicates**: Eliminated overlapping systems
3. **Clean State**: Single source of truth for all state
4. **Reliable Barge-in**: Integrated detection with proper cleanup
5. **Hot Reload Safe**: Singleton pattern prevents duplicates
6. **Clear Logging**: One log line per significant event
7. **Maintainable**: Simple, linear flow easy to debug

The refactored system provides a **clean, reliable, and maintainable** audio pipeline that meets all acceptance criteria while eliminating the complexity and conflicts of the original overlapping systems.
