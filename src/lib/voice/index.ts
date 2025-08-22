export function getSpeechRecognition(): any | null {
  if (typeof window === "undefined") return null;
  const SR: any = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = false;
  rec.lang = "en-US";
  console.info("[voice] SpeechRecognition constructed: en-US continuous");
  return rec;
}

export function speak(text: string, opts?: { rate?: number; pitch?: number; onend?: () => void }) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  try {
    try { window.speechSynthesis.cancel(); console.info("[voice] TTS cancel before speak"); } catch {}
    const u = new SpeechSynthesisUtterance(text);
    if (opts?.rate) u.rate = opts.rate;
    if (opts?.pitch) u.pitch = opts.pitch;
    u.onend = () => opts?.onend?.();
    try { window.speechSynthesis.speak(u); console.info("[voice] TTS speak start", { len: text.length }); } catch (e) { console.info("[voice] TTS speak error", e); }
  } catch {}
}

export function cancelSpeak() {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  try { window.speechSynthesis.cancel(); console.info("[voice] TTS cancel"); } catch (e) { console.info("[voice] TTS cancel error", e); }
}


