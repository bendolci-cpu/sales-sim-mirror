# Barge-In Threshold Adjustments

## Problem Identified

The logs showed that barge-in was being triggered by **dev-mode aggressive detection** (micRMS > 20) instead of normal detection thresholds. This was causing false positives from background noise.

## Threshold Adjustments Made

### 1. Ultra-Aggressive Detection
- **Before**: micRMS > 35
- **After**: micRMS > 45
- **Reason**: Reduce false positives from moderate background noise

### 2. Super-Aggressive Fallback
- **Before**: micRMS > 25 (when AI analyzer unavailable)
- **After**: micRMS > 35
- **Reason**: More reasonable threshold for fallback detection

### 3. Dev-Mode Detection
- **Before**: micRMS > 20
- **After**: micRMS > 30
- **Reason**: Reduce false positives in development mode

### 4. Normal Detection Thresholds
- **Human Threshold**: 15 → 20
- **AI Ratio**: 1.02 → 1.1 (more balanced)
- **Strong Speech**: 35 → 40
- **Barge-in Duration**: 30ms → 50ms (more reliable)
- **Reset Delay**: 100ms → 150ms (more stable)

### 5. Fallback Detection
- **Standard Fallback**: 25 → 35
- **Aggressive Fallback**: 20 → 30
- **Debug Logging**: 15 → 20

## Expected Behavior

### Before (Too Sensitive)
```
[Barge] DEV-MODE AGGRESSIVE - development mode detection: micRMS:21.6
[BARGE-IN] Entering barge-in state
```

### After (Balanced)
- Background noise (micRMS: 15-30) should NOT trigger barge-in
- Normal speech (micRMS: 30-45) should trigger normal detection
- Loud speech (micRMS: 45+) should trigger ultra-aggressive detection
- Clear speech over AI (micRMS > AI * 1.1) should trigger barge-in

## Testing Instructions

1. **Test background noise**: Should NOT trigger barge-in
2. **Test normal speech**: Should trigger within 50ms if loud enough
3. **Test loud speech**: Should trigger immediately (micRMS > 45)
4. **Test over AI**: Should trigger when mic > AI * 1.1

## Logging to Watch For

### Good Detection (micRMS > 30)
```
[BARGE-IN] Detected (micRMS:45.2, aiRMS:23.1) → ULTRA-AGGRESSIVE
[BARGE-IN] Entering barge-in state
```

### Normal Detection (micRMS: 20-45)
```
[Barge] Starting detection - micRMS:35.3, aiRMS:25.2, threshold:20, ratio:1.1
[BARGE-IN] Entering barge-in state
```

### No False Positives (micRMS < 20)
```
[Barge] Monitoring - micRMS:18.6, aiRMS:95.2, state:ai_playing, detected:false
// No barge-in triggered
```

## Performance Impact

- **Reduced false positives**: Less background noise triggering barge-in
- **Maintained responsiveness**: Still triggers quickly on actual speech
- **Better reliability**: More stable detection with longer duration
- **Balanced sensitivity**: Works well in both quiet and noisy environments
