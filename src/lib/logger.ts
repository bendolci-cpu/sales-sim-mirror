// Professional logging utility with log levels, change detection, and throttling

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
}

class Logger {
  private level: LogLevel;
  private changeCache = new Map<string, any>();
  private throttleCache = new Map<string, number>();

  constructor() {
    // Get log level from environment variable
    const envLevel = process.env.NEXT_PUBLIC_LOG_LEVEL?.toLowerCase();
    this.level = this.parseLogLevel(envLevel);
  }

  private parseLogLevel(level?: string): LogLevel {
    switch (level) {
      case 'error':
        return LogLevel.ERROR;
      case 'warn':
        return LogLevel.WARN;
      case 'info':
        return LogLevel.INFO;
      case 'debug':
        return LogLevel.DEBUG;
      default:
        // Default: quiet in production, info in development
        return process.env.NODE_ENV === 'production' ? LogLevel.INFO : LogLevel.INFO;
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return level <= this.level;
  }

  private formatMessage(level: string, message: string, ...args: any[]): string {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0]; // HH:MM:SS
    return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  }

  error(message: string, ...args: any[]): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      console.error(this.formatMessage('error', message), ...args);
    }
  }

  warn(message: string, ...args: any[]): void {
    if (this.shouldLog(LogLevel.WARN)) {
      console.warn(this.formatMessage('warn', message), ...args);
    }
  }

  info(message: string, ...args: any[]): void {
    if (this.shouldLog(LogLevel.INFO)) {
      console.log(this.formatMessage('info', message), ...args);
    }
  }

  debug(message: string, ...args: any[]): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      console.log(this.formatMessage('debug', message), ...args);
    }
  }

  // Helper: Only log when value changes
  logChange(key: string, value: any, message: string, ...args: any[]): void {
    const previousValue = this.changeCache.get(key);
    if (previousValue !== value) {
      this.changeCache.set(key, value);
      this.info(`${message} (${previousValue} → ${value})`, ...args);
    }
  }

  // Helper: Throttle logs to once per second
  logThrottled(key: string, message: string, throttleMs: number = 1000, ...args: any[]): void {
    const now = Date.now();
    const lastLog = this.throttleCache.get(key) || 0;
    
    if (now - lastLog >= throttleMs) {
      this.throttleCache.set(key, now);
      this.debug(message, ...args);
    }
  }

  // Helper: Log summary instead of full objects
  logSummary(prefix: string, items: any[], maxItems: number = 3): void {
    if (items.length === 0) {
      this.info(`${prefix}: empty`);
    } else if (items.length <= maxItems) {
      this.info(`${prefix}: ${items.length} items`, items);
    } else {
      this.info(`${prefix}: ${items.length} items (showing first ${maxItems})`, items.slice(0, maxItems));
    }
  }

  // Helper: Clear caches (useful for cleanup)
  clearCaches(): void {
    this.changeCache.clear();
    this.throttleCache.clear();
  }
}

// Export singleton instance
export const logger = new Logger();

// Export convenience functions
export const logError = (message: string, ...args: any[]) => logger.error(message, ...args);
export const logWarn = (message: string, ...args: any[]) => logger.warn(message, ...args);
export const logInfo = (message: string, ...args: any[]) => logger.info(message, ...args);
export const logDebug = (message: string, ...args: any[]) => logger.debug(message, ...args);
export const logChange = (key: string, value: any, message: string, ...args: any[]) => logger.logChange(key, value, message, ...args);
export const logThrottled = (key: string, message: string, throttleMs?: number, ...args: any[]) => logger.logThrottled(key, message, throttleMs, ...args);
export const logSummary = (prefix: string, items: any[], maxItems?: number) => logger.logSummary(prefix, items, maxItems);
