import { speak } from './index';

const PHRASES = ["mm-hmm", "go on", "take your time", "I'm listening"];
let lastAt = 0;

export function maybeBackchannel(now = Date.now()): void {
  const enabled = (process.env.NEXT_PUBLIC_BACKCHANNELS ?? 'true') !== 'false';
  if (!enabled) return;
  if (now - lastAt < 4000) return;
  // Lightweight speak
  const phrase = PHRASES[Math.floor(Math.random() * PHRASES.length)];
  try {
    speak(phrase, { lightweight: true });
    lastAt = now;
  } catch {}
}


