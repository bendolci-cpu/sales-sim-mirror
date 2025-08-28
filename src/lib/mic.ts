export type MicStatus = 'idle' | 'requesting' | 'listening' | 'blocked' | 'stopped' | 'error';
export type MicListener = (s: MicStatus) => void;

class MicService {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private status: MicStatus = 'idle';
  private listeners: Set<MicListener> = new Set();

  onStatus(fn: MicListener) { this.listeners.add(fn); fn(this.status); return () => { this.listeners.delete(fn); }; }
  private setStatus(s: MicStatus) { this.status = s; this.listeners.forEach(l => l(s)); }

  getStream(): MediaStream | null { return this.stream; }
  isActive(): boolean { return !!this.stream && this.status === 'listening'; }

  async enumerateAudioInputs(): Promise<MediaDeviceInfo[]> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter(d => d.kind === 'audioinput');
    } catch { return []; }
  }

  private async getValidConstraints(prefDeviceId?: string): Promise<MediaStreamConstraints> {
    const mics = await this.enumerateAudioInputs();
    let chosen: MediaDeviceInfo | undefined = undefined;
    if (prefDeviceId) chosen = mics.find(d => d.deviceId === prefDeviceId);
    if (!chosen) chosen = mics[0];
    const deviceConstraint = chosen?.deviceId ? { exact: chosen.deviceId } : undefined;
    return { audio: { deviceId: deviceConstraint, echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } } as any;
  }

  async start(prefDeviceId?: string): Promise<MediaStream | null> {
    if (this.isActive()) return this.stream;
    this.setStatus('requesting');
    try {
      const constraints = await this.getValidConstraints(prefDeviceId);
      // Never persist a deviceId; constraints may have undefined deviceId and still work with {audio:true}-like.
      const stream = await navigator.mediaDevices.getUserMedia(constraints).catch(async (e) => {
        // Retry with { audio: true } if constrained request fails
        return await navigator.mediaDevices.getUserMedia({ audio: true });
      });
      this.stream = stream;
      this.setStatus('listening');
      return stream;
    } catch (e: any) {
      const name = e?.name || '';
      if (name === 'NotFoundError' || name === 'SecurityError' || name === 'NotAllowedError' || name === 'PermissionDeniedError') this.setStatus('blocked');
      else this.setStatus('error');
      throw e;
    }
  }

  // Method to set an existing stream (useful when stream is obtained elsewhere)
  setStream(stream: MediaStream): void {
    this.stream = stream;
    this.setStatus('listening');
  }

  stop(): void {
    try { this.recorder?.stop(); } catch {}
    try { this.stream?.getTracks().forEach(t => t.stop()); } catch {}
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.setStatus('stopped');
  }

  startRecording(mime: string = 'audio/webm') {
    if (!this.stream) throw new Error('No active mic stream');
    try {
      const rec = new MediaRecorder(this.stream, { mimeType: mime } as any);
      this.chunks = [];
      rec.ondataavailable = (ev: BlobEvent) => { if (ev.data && ev.data.size > 0) this.chunks.push(ev.data); };
      this.recorder = rec;
      rec.start(250);
    } catch (e) { console.error('MediaRecorder start failed', e); }
  }

  async stopRecording(): Promise<Blob | null> {
    if (!this.recorder) return null;
    const rec = this.recorder;
    return new Promise<Blob | null>((resolve) => {
      try {
        rec.onstop = () => {
          try {
            const blob = new Blob(this.chunks, { type: rec.mimeType });
            this.chunks = [];
            resolve(blob);
          } catch (e) { console.error('Record finalize failed', e); resolve(null); }
        };
        rec.stop();
        this.recorder = null;
      } catch (e) { console.error('Recorder stop failed', e); resolve(null); }
    });
  }
}

export const mic = new MicService();

// Small hook for status consumption
import { useEffect, useState } from 'react';
export function useMicStatus(): MicStatus {
  const [s, setS] = useState<MicStatus>('idle');
  useEffect(() => mic.onStatus(setS), []);
  return s;
}


