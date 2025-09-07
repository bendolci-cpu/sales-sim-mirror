export function shouldRespondNow(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  const words = t.split(/\s+/).filter(Boolean).length;
  if (words >= 4) return true;
  if (/[?]$/.test(t)) return true;
  if (/(\bcan|could|should|what|why|how|when|where)\b/i.test(t)) return true;
  return false;
}

export class TurnBuffer {
  private buf: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onFlush: (text: string) => void;
  private pending: string = '';

  constructor(onFlush: (text: string) => void) {
    this.onFlush = onFlush;
  }

  append(text: string) {
    const t = (text || '').trim();
    if (!t) return;
    this.buf.push(t);
    this.pending = this.buf.join(' ').replace(/\s+/g, ' ').trim();
  }

  scheduleFlush(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.drain(), ms);
  }

  cancelFlush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  drain() {
    if (!this.pending) return;
    const out = this.pending;
    this.buf = [];
    this.pending = '';
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.onFlush(out);
  }
}


