"use client";

import { isSpeaking, speak, stop as stopTTS } from "./tts";
import { useSpeech } from "./useSpeech";

export type CallState = "idle" | "ringing" | "connected" | "ended";

type Listener = (s: CallState) => void;

export class CallController {
  private state: CallState = "idle";
  private listeners: Set<Listener> = new Set();
  private audioCtx: AudioContext | null = null;
  private ringOsc: OscillatorNode | null = null;
  private ringGain: GainNode | null = null;
  private micStream: MediaStream | null = null;

  onStateChange(cb: Listener) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  getState(): CallState { return this.state; }
  private setState(s: CallState) { this.state = s; this.listeners.forEach(l => l(s)); }

  async start(): Promise<void> {
    if (this.state !== "idle") return;
    await this.unlockAudio();
    await this.prepareMic();
    await this.playRing(1000);
    this.setState("connected");
  }

  async end(): Promise<void> {
    this.stopRing();
    stopTTS();
    if (this.micStream) {
      this.micStream.getTracks().forEach(t => t.stop());
      this.micStream = null;
    }
    try { await this.audioCtx?.close(); } catch {}
    this.audioCtx = null;
    this.setState("ended");
  }

  stopTTS() { stopTTS(); }

  isTTSSpeaking(): boolean { return isSpeaking(); }

  async ttsSpeak(text: string) { await speak(text); }

  private async unlockAudio(): Promise<void> {
    const AC: any = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    if (!this.audioCtx) this.audioCtx = new AC();
    try { await this.audioCtx.resume(); } catch {}
  }

  private async prepareMic(): Promise<void> {
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // If denied, we still proceed without mic
    }
  }

  private async playRing(durationMs: number): Promise<void> {
    if (!this.audioCtx) return;
    this.setState("ringing");
    const osc = this.audioCtx.createOscillator();
    const gain = this.audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.value = 0.05;
    osc.connect(gain).connect(this.audioCtx.destination);
    osc.start();
    this.ringOsc = osc; this.ringGain = gain;
    await new Promise(res => setTimeout(res, durationMs));
    this.stopRing();
  }

  private stopRing(): void {
    try { this.ringOsc?.stop(); } catch {}
    try { this.ringOsc?.disconnect(); } catch {}
    try { this.ringGain?.disconnect(); } catch {}
    this.ringOsc = null; this.ringGain = null;
  }
}


