interface LogEntry { timestamp: number; count: number; }
const dedupeMap = new Map<string, LogEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of dedupeMap.entries()) {
    if (now - entry.timestamp > 2000) dedupeMap.delete(key);
  }
}, 5000);

function computeKey(level: string, domain: string, message: string): string {
  return `${level}|${domain}|${message}`;
}

function shouldLog(key: string): boolean {
  const now = Date.now();
  const existing = dedupeMap.get(key);

  if (!existing) {
    dedupeMap.set(key, { timestamp: now, count: 1 });
    return true;
  }

  if (now - existing.timestamp < 2000) {
    existing.count++;
    return false;
  }

  if (existing.count > 1) {
    console.log(`[LOGGER] Suppressed ${existing.count - 1} duplicate messages`);
  }

  dedupeMap.set(key, { timestamp: now, count: 1 });
  return true;
}

function formatMessage(level: string, domain: string, message: string): string {
  const timestamp = new Date().toISOString().substr(11, 12); // HH:MM:SS.mmm
  return `[${timestamp}] [${level}] [${domain}] ${message}`;
}

export function info(domain: string, message: string, ...args: any[]): void {
  const key = computeKey('INFO', domain, message);
  if (shouldLog(key)) console.log(formatMessage('INFO', domain, message), ...args);
}

export function warn(domain: string, message: string, ...args: any[]): void {
  const key = computeKey('WARN', domain, message);
  if (shouldLog(key)) console.warn(formatMessage('WARN', domain, message), ...args);
}

export function error(domain: string, message: string, ...args: any[]): void {
  const key = computeKey('ERROR', domain, message);
  if (shouldLog(key)) console.error(formatMessage('ERROR', domain, message), ...args);
}

export function debug(domain: string, message: string, ...args: any[]): void {
  if (process.env.NODE_ENV === 'development') {
    const key = computeKey('DEBUG', domain, message);
    if (shouldLog(key)) console.log(formatMessage('DEBUG', domain, message), ...args);
  }
}

// Legacy compatibility
export const logInfo = (message: string, ...args: any[]) => info('LEGACY', message, ...args);
export const logWarn = (message: string, ...args: any[]) => warn('LEGACY', message, ...args);
export const logError = (message: string, ...args: any[]) => error('LEGACY', message, ...args);
export const logDebug = (message: string, ...args: any[]) => debug('LEGACY', message, ...args);