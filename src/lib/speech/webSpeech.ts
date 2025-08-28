export type WebSpeechControls = {
  start: () => void;
  stop: () => void;
  isActive: () => boolean;
};

type Handlers = {
  onInterim?: (text: string) => void;
  onFinal?: (text: string) => void;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
};

export function createWebSpeech(handlers: Handlers): WebSpeechControls | null {
  if (typeof window === "undefined") return null;
  const SR: any = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
  if (!SR) return null;
  let rec: any = null;
  let active = false;
  let endedExternally = false;
  let restartCount = 0;
  const MAX_RESTARTS = 5; // Prevent infinite restart loops

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
    rec.onspeechstart = () => { handlers.onSpeechStart?.(); };
    rec.onspeechend = () => { handlers.onSpeechEnd?.(); };
    rec.onerror = (event: any) => {
      console.warn("[WebSpeech] Error:", event.error);
      // Don't restart on certain errors that indicate permanent issues
      if (event.error === 'not-allowed' || event.error === 'network' || event.error === 'no-speech') {
        endedExternally = true;
        active = false;
      }
    };
    rec.onend = () => {
      active = false;
      if (!endedExternally && restartCount < MAX_RESTARTS) {
        // Add delay before restart to prevent rapid cycling
        restartCount++;
        console.log(`[WebSpeech] Restarting (${restartCount}/${MAX_RESTARTS})...`);
        setTimeout(() => {
          if (!endedExternally) {
            start();
          }
        }, 1000); // 1 second delay
      } else if (restartCount >= MAX_RESTARTS) {
        console.warn("[WebSpeech] Max restarts reached, stopping");
        endedExternally = true;
      }
    };
    try { 
      rec.start(); 
      active = true; 
    } catch (e) {
      console.error("[WebSpeech] Failed to start:", e);
      active = false;
    }
  };

  const stop = () => {
    endedExternally = true;
    restartCount = 0; // Reset restart count when manually stopped
    try { rec?.stop?.(); } catch {}
    active = false;
  };

  const isActive = () => active;

  return { start, stop, isActive };
}


