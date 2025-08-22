"use client";

import { useEffect, useRef, useState } from "react";
import { SpeechManager } from "@/lib/voice/SpeechManager";
import { mic, useMicStatus } from "@/lib/mic";

export default function MicDebugPage() {
  const [status, setStatus] = useState(SpeechManager.state.status);
  const [lastError, setLastError] = useState<string | undefined>(SpeechManager.state.lastError);
  const [interim, setInterim] = useState<string>("");
  const [lines, setLines] = useState<string[]>([]);
  const micStatus = useMicStatus();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  useEffect(() => {
    const offRes = SpeechManager.onResult(({ interim, final }) => {
      if (interim) setInterim(interim);
      if (final) { setInterim(""); setLines(prev => [final, ...prev].slice(0, 20)); }
    });
    const offSt = SpeechManager.onStatus((s) => setStatus(s));
    const offErr = SpeechManager.onError((e) => setLastError(String(e)));
    return () => { offRes(); offSt(); offErr(); };
  }, []);

  async function startVu() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const AC: any = (window as any).AudioContext || (window as any).webkitAudioContext;
      const ctx = new AC(); audioCtxRef.current = ctx;
      const analyser = ctx.createAnalyser(); analyser.fftSize = 256; analyserRef.current = analyser;
      const src = ctx.createMediaStreamSource(stream); src.connect(analyser);
      const cvs = canvasRef.current!; const g = cvs.getContext("2d")!;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const render = () => {
        analyser.getByteTimeDomainData(data);
        g.clearRect(0, 0, cvs.width, cvs.height);
        const rms = Math.sqrt(data.reduce((s, v) => s + Math.pow((v - 128) / 128, 2), 0) / data.length);
        const h = cvs.height; const w = cvs.width; const bars = 8; const bw = Math.max(2, Math.floor(w / (bars * 2)));
        for (let i = 0; i < bars; i++) {
          const bh = Math.max(2, Math.floor(h * (0.2 + Math.random() * 0.2 + rms * 0.6)));
          const x = i * (bw + 6) + 4; g.fillStyle = "#10b981"; g.fillRect(x, h - bh, bw, bh);
        }
        rafRef.current = requestAnimationFrame(render);
      };
      rafRef.current = requestAnimationFrame(render);
    } catch {}
  }

  function stopVu() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    try { audioCtxRef.current?.close(); } catch {}
    rafRef.current = null; audioCtxRef.current = null; analyserRef.current = null;
  }

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-lg font-semibold text-gray-900">Mic Diagnostics</h1>
      <div className="rounded-lg border bg-white p-4">
        <div className="flex items-center justify-between">
          <div className="text-sm text-gray-700">Status: <span className="font-medium">{status}</span></div>
          {lastError && <div className="text-xs text-amber-700">{lastError}</div>}
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs text-white" onClick={async () => { await mic.start(); SpeechManager.start(); startVu(); }}>Start</button>
          <button className="rounded-md bg-rose-600 px-3 py-1.5 text-xs text-white" onClick={() => { mic.stop(); SpeechManager.stop(); stopVu(); }}>Stop</button>
          <button className="rounded-md border px-3 py-1.5 text-xs" onClick={() => setLines([])}>Clear Logs</button>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <canvas ref={canvasRef} width={120} height={32} className="rounded bg-gray-50" />
          <div className="text-[12px] text-gray-500">{interim}</div>
        </div>
      </div>
      <div className="rounded-lg border bg-white p-4">
        <div className="text-sm font-medium">Final lines</div>
        <ul className="mt-2 space-y-1 text-[13px] text-gray-800">
          {lines.map((l, i) => (<li key={i}>• {l}</li>))}
        </ul>
      </div>
      <div className="text-[11px] text-gray-500">Mic status: {micStatus}</div>
      <div className="text-[11px] text-gray-500">
        {/* Test plan: Start -> expect warming→listening, interim while speaking, finals append. Block mic then reload -> status 'blocked'. Use unsupported browser -> 'unsupported'. */}
      </div>
    </main>
  );
}


