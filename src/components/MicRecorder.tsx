"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";

export type MicRecorderProps = {
  onText: (text: string) => void;
  className?: string;
};

// Placeholder for future server-side Whisper integration
export async function transcribeServer(_blob: Blob): Promise<string | null> {
  // Swap to server Whisper by POSTing FormData(file) to /api/transcribe and using its { text }
  return null;
}

type SpeechRecognitionType = typeof window extends never
  ? unknown
  : (typeof window & {
      webkitSpeechRecognition?: any;
      SpeechRecognition?: any;
    })["SpeechRecognition"];

export default function MicRecorder({ onText, className }: MicRecorderProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const recognitionRef = useRef<SpeechRecognitionType | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  const startedAtRef = useRef<number>(0);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [seconds, setSeconds] = useState<number>(0);
  const [isSupported, setIsSupported] = useState<boolean>(true);

  // Check support on mount
  useEffect(() => {
    const hasSR = typeof window !== "undefined" && ("webkitSpeechRecognition" in window || "SpeechRecognition" in window);
    setIsSupported(hasSR);
  }, []);

  // Draw small equalizer while recording
  const drawEQ = useCallback(() => {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const width = canvas.width;
    const height = canvas.height;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    const render = () => {
      analyser.getByteFrequencyData(dataArray);
      ctx.clearRect(0, 0, width, height);
      const bars = 8;
      const step = Math.floor(dataArray.length / bars);
      const barWidth = Math.max(1, Math.floor(width / (bars * 1.5)));
      for (let i = 0; i < bars; i++) {
        const v = dataArray[i * step] / 255;
        const barHeight = Math.max(1, Math.floor(v * height));
        const x = i * (barWidth + 2) + 1;
        const y = height - barHeight;
        ctx.fillStyle = "#0ea5e9"; // sky-500
        ctx.fillRect(x, y, barWidth, barHeight);
      }
      rafRef.current = requestAnimationFrame(render);
    };
    rafRef.current = requestAnimationFrame(render);
  }, []);

  const stopEQ = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx && canvasRef.current) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
  }, []);

  const cleanupAudio = useCallback(() => {
    stopEQ();
    if (sourceRef.current) {
      try { sourceRef.current.disconnect(); } catch {}
      sourceRef.current = null;
    }
    if (analyserRef.current) {
      try { analyserRef.current.disconnect(); } catch {}
      analyserRef.current = null;
    }
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch {}
      audioCtxRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
  }, [stopEQ]);

  const startAudio = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);
      streamRef.current = stream;
      audioCtxRef.current = audioCtx;
      analyserRef.current = analyser;
      sourceRef.current = source;
      drawEQ();
    } catch {
      // If getUserMedia fails, ignore EQ
    }
  }, [drawEQ]);

  const stopRecognition = useCallback(() => {
    setIsRecording(false);
    const rec: any = recognitionRef.current;
    if (rec) {
      try { rec.stop(); } catch {}
      recognitionRef.current = null;
    }
    cleanupAudio();
  }, [cleanupAudio]);

  const startRecognition = useCallback(() => {
    if (!isSupported) return;
    const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;

    const rec: any = new SR();
    rec.lang = "en-US";
    rec.interimResults = true;
    let finalTranscript = "";

    rec.onresult = (event: any) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript;
        }
      }
    };
    rec.onend = () => {
      if (finalTranscript.trim()) onText(finalTranscript.trim());
      stopRecognition();
    };
    rec.onerror = () => {
      stopRecognition();
    };

    recognitionRef.current = rec;
    startedAtRef.current = Date.now();
    setSeconds(0);
    setIsRecording(true);
    rec.start();
    startAudio();
  }, [isSupported, onText, startAudio, stopRecognition]);

  // Simple timer while recording
  useEffect(() => {
    if (!isRecording) return;
    const id = setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 250);
    return () => clearInterval(id);
  }, [isRecording]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      try { (recognitionRef.current as any)?.stop?.(); } catch {}
      cleanupAudio();
    };
  }, [cleanupAudio]);

  return (
    <div className={`relative flex items-center gap-2 ${className ?? ""}`}>
      <button
        ref={buttonRef}
        type="button"
        onPointerDown={(e) => {
          if (!isSupported) return;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          startRecognition();
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture?.(e.pointerId);
          if (isRecording) stopRecognition();
        }}
        onPointerLeave={() => {
          if (isRecording) stopRecognition();
        }}
        disabled={!isSupported}
        title={isSupported ? "Hold to speak" : "Voice input requires Chrome/Edge."}
        className={`relative inline-flex h-10 w-10 items-center justify-center rounded-full bg-white text-sky-600 ring-1 ring-gray-200 shadow-sm hover:bg-sky-50 active:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50`}
      >
        {isRecording && (
          <span className="pointer-events-none absolute inset-0 -z-10 inline-flex h-full w-full animate-ping rounded-full bg-sky-200" />
        )}
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
          <path d="M12 14a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v4a3 3 0 0 0 3 3Zm-7-3a1 1 0 1 0-2 0 9 9 0 0 0 8 8.94V22a1 1 0 1 0 2 0v-2.06A9 9 0 0 0 19 11a1 1 0 1 0-2 0 7 7 0 1 1-14 0Z" />
        </svg>
      </button>

      <div className="flex items-center gap-2">
        <canvas
          ref={canvasRef}
          width={36}
          height={12}
          className={`transition-opacity ${isRecording ? "opacity-100" : "opacity-0"}`}
          aria-hidden
        />
        {isRecording && (
          <span className="text-[11px] text-gray-500">● {seconds}s</span>
        )}
      </div>
    </div>
  );
}


