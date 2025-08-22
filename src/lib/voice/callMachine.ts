export type CallState = "idle" | "ringing" | "connected" | "ended";

type Listener = (state: CallState, elapsedMs: number) => void;

export class CallMachine {
  private state: CallState = "idle";
  private listeners: Set<Listener> = new Set();
  private startedAt: number | null = null;
  private tickId: number | null = null;
  private elapsedMs: number = 0;

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    listener(this.state, this.elapsedMs);
    return () => this.listeners.delete(listener);
  }

  getState(): CallState { return this.state; }
  getElapsedMs(): number { return this.elapsedMs; }

  private emit() { this.listeners.forEach(l => l(this.state, this.elapsedMs)); }

  start() {
    if (this.state !== "idle" && this.state !== "ended") return;
    this.state = "ringing";
    this.elapsedMs = 0;
    this.startedAt = null;
    this.clearTick();
    this.emit();
  }

  answer() {
    if (this.state !== "ringing") return;
    this.state = "connected";
    this.startedAt = Date.now();
    this.elapsedMs = 0;
    this.startTick();
    this.emit();
  }

  end() {
    if (this.state === "idle" || this.state === "ended") return;
    this.updateElapsed();
    this.state = "ended";
    this.clearTick();
    this.emit();
  }

  reset() {
    this.clearTick();
    this.state = "idle";
    this.elapsedMs = 0;
    this.startedAt = null;
    this.emit();
  }

  private startTick() {
    this.clearTick();
    this.tickId = window.setInterval(() => {
      this.updateElapsed();
      this.emit();
    }, 250);
  }

  private updateElapsed() {
    if (this.startedAt) this.elapsedMs = Date.now() - this.startedAt;
  }

  private clearTick() {
    if (this.tickId) window.clearInterval(this.tickId);
    this.tickId = null;
  }
}


