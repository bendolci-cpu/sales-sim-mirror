# Professional Logging System

This project uses a professional logging system to reduce console spam and provide clean, actionable logs.

## Features

- **Log Levels**: `error`, `warn`, `info`, `debug`
- **Change Detection**: Only log when values change
- **Throttling**: Limit noisy logs to once per second
- **Summary Logging**: Show counts instead of full objects
- **Environment Control**: Set log level via `NEXT_PUBLIC_LOG_LEVEL`

## Usage

### Basic Logging
```typescript
import { logError, logWarn, logInfo, logDebug } from '@/lib/logger';

logError('Critical error occurred');
logWarn('Warning: something unexpected');
logInfo('Normal operation info');
logDebug('Detailed debug information');
```

### Change Detection
```typescript
import { logChange } from '@/lib/logger';

// Only logs when the value changes
logChange('user-state', isLoggedIn, 'User login state');
// Output: [INFO] User login state (false → true)
```

### Throttled Logging
```typescript
import { logThrottled } from '@/lib/logger';

// In a loop - only logs once per second
logThrottled('monitoring-loop', 'Processing data...', 1000);
```

### Summary Logging
```typescript
import { logSummary } from '@/lib/logger';

// Instead of dumping full arrays
logSummary('User turns', turns, 3);
// Output: [INFO] User turns: 15 items (showing first 3)
```

## Environment Configuration

Set `NEXT_PUBLIC_LOG_LEVEL` in your environment:

```bash
# .env.local
NEXT_PUBLIC_LOG_LEVEL=debug  # Most verbose
NEXT_PUBLIC_LOG_LEVEL=info   # Normal operation (default)
NEXT_PUBLIC_LOG_LEVEL=warn   # Warnings and errors only
NEXT_PUBLIC_LOG_LEVEL=error  # Errors only
```

## What's Been Updated

### BargeInDetector
- Monitoring logs are now throttled to once per second
- Only logs when there's significant activity

### ASRManager
- `isSpeech()` calls no longer spam the console
- Speech state changes are logged with change detection

### ReviewPlayer
- Full object dumps replaced with summary logging
- Shows counts and first few items instead of entire arrays

### Mic/LiveKit
- Track ID changes are logged with change detection
- State changes are logged only when they change

### Enhanced Speech
- Audio start/end events moved to debug level
- Recognition start/end remain at info level

## Benefits

1. **Clean Console**: No more spam from repeated values
2. **Actionable Logs**: Only see what's actually changing
3. **Performance**: Reduced console overhead
4. **Flexibility**: Control verbosity per environment
5. **Professional**: Timestamped, leveled logs

## Default Behavior

- **Development**: `info` level (normal operation logs)
- **Production**: `warn` level (warnings and errors only)
- **Debug Mode**: Set `NEXT_PUBLIC_LOG_LEVEL=debug` for detailed telemetry
