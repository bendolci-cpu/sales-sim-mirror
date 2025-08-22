"use client";

import { useEffect, useRef } from "react";

type MicVizProps = {
  stream?: MediaStream | null;
  active?: boolean;
};

export default function MicViz({ stream, active }: MicVizProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active || !stream) { if (rafRef.current) cancelAnimationFrame(rafRef.current); return; }
    const AC: any = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    const src = ctx.createMediaStreamSource(stream);
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const canvas = canvasRef.current!;
    const g = canvas.getContext("2d")!;

    const bars = 6;
    const render = () => {
      analyser.getByteTimeDomainData(data);
      g.clearRect(0, 0, canvas.width, canvas.height);
      const rms = Math.sqrt(data.reduce((s, v) => s + Math.pow((v - 128) / 128, 2), 0) / data.length);
      const scale = Math.min(1, rms * 4);
      const w = canvas.width; const h = canvas.height;
      const bw = Math.max(2, Math.floor(w / (bars * 2)));
      for (let i = 0; i < bars; i++) {
        const bh = Math.max(2, Math.floor(h * (0.2 + Math.random() * 0.2 + scale * 0.6)));
        const x = i * (bw + 6) + 4;
        g.fillStyle = "#10b981"; // emerald-500
        g.fillRect(x, h - bh, bw, bh);
      }
      rafRef.current = requestAnimationFrame(render);
    };
    rafRef.current = requestAnimationFrame(render);
    return () => { try { ctx.close(); } catch {}; if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [stream, active]);

  return <canvas ref={canvasRef} width={90} height={24} className={`transition-opacity ${active ? "opacity-100" : "opacity-0"}`} aria-hidden />;
}


