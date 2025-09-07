type SpeakOpts = { lightweight?: boolean };

let onStartCb: ((text: string) => void) | null = null;
let onEndCb: ((text: string) => void) | null = null;

export function onStart(cb: (text: string) => void) { onStartCb = cb; }
export function onEnd(cb: (text: string) => void) { onEndCb = cb; }

export async function speak(text: string, opts: SpeakOpts = {}): Promise<void> {
  const t = (text || '').trim();
  if (!t) return;
  onStartCb?.(t);
  // Basic browser TTS implementation for now
  if ('speechSynthesis' in window) {
    await new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(t);
      if (opts.lightweight) {
        u.rate = 1.1; u.pitch = 1.0; u.volume = 0.7;
      } else {
        u.rate = 0.95; u.pitch = 1.0; u.volume = 0.9;
      }
      u.onend = () => { onEndCb?.(t); resolve(); };
      u.onerror = () => { onEndCb?.(t); resolve(); };
      speechSynthesis.speak(u);
    });
    return;
  }
  onEndCb?.(t);
}

export function stop(): void {
  try { window.speechSynthesis?.cancel(); } catch {}
}


