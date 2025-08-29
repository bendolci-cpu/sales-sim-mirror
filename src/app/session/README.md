# Session Pipeline

This session page uses a unified audio pipeline for reliable voice interaction with barge-in capabilities.

## Pipeline Lifecycle

1. **Initialization**: AudioContext (24kHz), microphone, speech recognition
2. **Call Start**: Initialize pipeline, connect message dispatcher, play greeting
3. **Active Session**: 
   - ASR captures user speech
   - TTS plays AI responses
   - Barge-in monitoring during TTS
4. **Call End**: Cleanup pipeline, stop all audio, disconnect

## Audio Thresholds

- `MIC_RMS_SPEECH`: 55 (user speech detection)
- `AI_RMS_GATE`: 20 (AI audio gate)
- `MIN_UTTERANCE_MS`: 600 (minimum utterance length)

## Key Features

- **Unified Pipeline**: Single source of truth for all audio operations
- **Barge-in**: Interrupt TTS when user speaks loudly
- **HMR Safe**: Proper cleanup on hot reload
- **Mock/Live Toggle**: Switch between mock and live modes
- **Graceful Cleanup**: No leaked analyzers or event listeners

## Architecture

- Uses `UnifiedAudioPipeline` for all audio operations
- Message dispatcher for speech-to-text processing
- LiveKit integration for live mode
- Enhanced speech recognition with barge-in detection
