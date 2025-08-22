export type WebSpeechControls = {
  start: () => void;
  stop: () => void;
  isActive: () => boolean;
};

type Handlers = {
  onInterim?: (text: string) => void;
  onFinal?: (text: string) => void;
};

export function createWebSpeech(handlers: Handlers): WebSpeechControls | null {
  if (typeof window === "undefined") return null;
  const SR: any = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
  if (!SR) return null;
  let rec: any = null;
  let active = false;
  let endedExternally = false;

  const start = () => {
    if (active) return;
    endedExternally = false;
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    let finalBuffer = "";
    rec.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalBuffer += r[0].transcript; else interim += r[0].transcript;
      }
      const interimCombined = (finalBuffer + " " + interim).trim();
      if (interimCombined && handlers.onInterim) handlers.onInterim(interimCombined);
      if (finalBuffer.trim()) {
        handlers.onFinal?.(finalBuffer.trim());
        finalBuffer = "";
      }
    };
    rec.onerror = () => {
      // soft restart unless stopped externally
    };
    rec.onend = () => {
      active = false;
      if (!endedExternally) {
        // restart automatically
        start();
      }
    };
    try { rec.start(); active = true; } catch {}
  };

  const stop = () => {
    endedExternally = true;
    try { rec?.stop?.(); } catch {}
    active = false;
  };

  const isActive = () => active;

  return { start, stop, isActive };
}


