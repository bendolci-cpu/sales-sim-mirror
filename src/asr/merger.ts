let pending: { text: string; lastAt: number } | null = null;

export function reset() {
  pending = null;
}

export function absorbOrEmit(finalText: string): string | null {
  const now = Date.now();
  const text = (finalText || '').trim();
  if (!text) return null;
  if (!pending) {
    pending = { text, lastAt: now };
    return null;
  }
  if (now - pending.lastAt <= 1500) {
    pending.text = `${pending.text} ${text}`.replace(/\s+/g, ' ').trim();
    pending.lastAt = now;
    return null;
  }
  const out = pending.text;
  pending = { text, lastAt: now };
  return out;
}


