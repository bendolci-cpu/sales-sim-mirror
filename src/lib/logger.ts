// Smart logger with timestamp, domain tags, and de-duplication
// Reduces console noise by preventing repeated identical messages within 2 seconds

interface LogEntry {
  timestamp: number;
  count: number;
}

// De-duplication map: message -> { timestamp, count }
const dedupeMap = new Map<string, LogEntry>();

// Clean up old entries every 5 seconds
setInterval(() => {
  const now = Date.now();
  for (const [message, entry] of dedupeMap.entries()) {
    if (now - entry.timestamp > 2000) {
      dedupeMap.delete(message);
    }
  }
}, 5000);

function shouldLog(message: string): boolean {
  const now = Date.now();
  const existing = dedupeMap.get(message);
  
  if (!existing) {
    dedupeMap.set(message, { timestamp: now, count: 1 });
    return true;
  }
  
  // If within 2 seconds, increment count and don't log
  if (now - existing.timestamp < 2000) {
    existing.count++;
    return false;
  }
  
  // If count > 1, log the suppressed count
  if (existing.count > 1) {
    console.log(`[LOGGER] Suppressed ${existing.count - 1} duplicate messages`);
  }
  
  // Reset for new period
  dedupeMap.set(message, { timestamp: now, count: 1 });
  return true;
}

function formatMessage(level: string, domain: string, message: string, ...args: any[]): string {
  const timestamp = new Date().toISOString().substr(11, 12); // HH:MM:SS.mmm
  return `[${timestamp}] [${level}] [${domain}] ${message}`;
}

export function info(domain: string, message: string, ...args: any[]): void {
  const formattedMessage = formatMessage('INFO', domain, message);
  if (shouldLog(formattedMessage)) {
    console.log(formattedMessage, ...args);
  }
}

export function warn(domain: string, message: string, ...args: any[]): void {
  const formattedMessage = formatMessage('WARN', domain, message);
  if (shouldLog(formattedMessage)) {
    console.warn(formattedMessage, ...args);
  }
}

export function error(domain: string, message: string, ...args: any[]): void {
  const formattedMessage = formatMessage('ERROR', domain, message);
  if (shouldLog(formattedMessage)) {
    console.error(formattedMessage, ...args);
  }
}

export function debug(domain: string, message: string, ...args: any[]): void {
  // Only log debug in development
  if (process.env.NODE_ENV === 'development') {
    const formattedMessage = formatMessage('DEBUG', domain, message);
    if (shouldLog(formattedMessage)) {
      console.log(formattedMessage, ...args);
    }
  }
}

// Legacy compatibility - these will be replaced gradually
export const logInfo = (message: string, ...args: any[]) => info('LEGACY', message, ...args);
export const logWarn = (message: string, ...args: any[]) => warn('LEGACY', message, ...args);
export const logError = (message: string, ...args: any[]) => error('LEGACY', message, ...args);
export const logDebug = (message: string, ...args: any[]) => debug('LEGACY', message, ...args);