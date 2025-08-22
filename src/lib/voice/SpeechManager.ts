type Status = "idle" | "warming" | "listening" | "restarting" | "error" | "unsupported" | "blocked";

type ResultHandler = (data: { interim?: string; final?: string }) => void;
type StatusHandler = (status: Status) => void;
type ErrorHandler = (err: any) => void;

class SpeechManagerImpl {
  private rec: any | null = null;
  private active = false;
  private status: Status = "idle";
  private lastError: string | undefined = undefined;
  private onResultHandlers = new Set<ResultHandler>();
  private onStatusHandlers = new Set<StatusHandler>();
  private onErrorHandlers = new Set<ErrorHandler>();
  private backoffMs = 250;
  private restartTimer: number | null = null;

  onResult(cb: ResultHandler) { this.onResultHandlers.add(cb); return () => this.onResultHandlers.delete(cb); }
  onStatus(cb: StatusHandler) { this.onStatusHandlers.add(cb); cb(this.status); return () => this.onStatusHandlers.delete(cb); }
  onError(cb: ErrorHandler) { this.onErrorHandlers.add(cb); return () => this.onErrorHandlers.delete(cb); }

  private emitStatus(next: Status) {
    this.status = next; this.onStatusHandlers.forEach(h => h(next));
  }

  private emitResult(data: { interim?: string; final?: string }) {
    this.onResultHandlers.forEach(h => h(data));
  }

  private emitError(err: any) {
    this.onErrorHandlers.forEach(h => h(err));
  }

  async start() {
    if (typeof window === "undefined") return;
    const SR: any = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
    if (!SR) { this.status = "unsupported"; this.emitStatus("unsupported"); this.emitError(new Error("unsupported")); return; }
    try {
      this.emitStatus("warming");
      await getMicStream();
      // Optional: enumerate devices for future selection
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const mics = devices.filter(d => d.kind === "audioinput");
        console.info("[Speech] Available mics:", mics.map(m => ({ deviceId: m.deviceId, label: m.label })));
      } catch {}
    } catch (e: any) {
      const name = e?.name || "";
      this.lastError = name || String(e);
      if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "NotFoundError" || name === "OverConstrainedError") {
        this.emitStatus("blocked");
      } else {
        this.emitStatus("error");
      }
      this.emitError(e);
      return;
    }

    try {
      const rec = new SR();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = "en-US";
      rec.onresult = (e: any) => {
        let interim = ""; let finals: string[] = [];
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finals.push(r[0].transcript); else interim += r[0].transcript;
        }
        if (interim.trim()) this.emitResult({ interim: interim.trim() });
        const finalText = finals.join(" ").trim();
        if (finalText) this.emitResult({ final: finalText });
      };
      rec.onend = () => {
        console.info("[Speech] onend", { active: this.active });
        if (this.active) {
          this.emitStatus("restarting");
          if (this.restartTimer) window.clearTimeout(this.restartTimer);
          this.restartTimer = window.setTimeout(() => { try { rec.start(); this.emitStatus("listening"); } catch (e) { this.handleError(e); } }, this.backoffMs);
          this.backoffMs = Math.min(this.backoffMs * 2, 2000);
        } else {
          this.emitStatus("idle");
        }
      };
      rec.onerror = (e: any) => this.handleError(e);
      this.rec = rec;
      this.active = true;
      this.backoffMs = 250;
      try { rec.start(); this.emitStatus("listening"); console.info("[Speech] start listening"); } catch (e) { this.handleError(e); }
    } catch (e) {
      this.handleError(e);
    }
  }

  stop() {
    this.active = false;
    try { this.rec?.stop?.(); } catch {}
    this.emitStatus("idle");
    if (this.restartTimer) { window.clearTimeout(this.restartTimer); this.restartTimer = null; }
  }

  private handleError(e: any) {
    console.info("[Speech] error", e);
    this.lastError = (e?.error || e?.message || String(e));
    this.emitStatus("error");
    this.emitError(this.lastError);
    if (this.active) {
      if (this.restartTimer) window.clearTimeout(this.restartTimer);
      this.emitStatus("restarting");
      this.restartTimer = window.setTimeout(() => {
        try { this.rec?.start?.(); this.emitStatus("listening"); } catch (err) { this.handleError(err); }
        this.backoffMs = Math.min(this.backoffMs * 2, 2000);
      }, this.backoffMs);
    }
  }

  get state() {
    return { active: this.active, status: this.status, lastError: this.lastError } as { active: boolean; status: Status; lastError?: string };
  }
}

export const SpeechManager = new SpeechManagerImpl();

async function getMicStream() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return stream;
  } catch (err) {
    console.error("Mic access failed:", err);
    throw err;
  }
}


