"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type UseSpeechOpts = {
  lang?: string;
  onInterim?: (t: string) => void;
  onFinal?: (t: string) => void;
  silenceMs?: number;
};

export function useSpeech({ lang = "en-US", onInterim, onFinal, silenceMs = 700 }: UseSpeechOpts) {
  const recRef = useRef<any>(null);
  const [isActive, setIsActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const interimRef = useRef("");
  const finalRef = useRef("");
  const silenceTimerRef = useRef<number | null>(null);
  const endedRef = useRef(false);

  const fireSilenceCommit = useCallback(() => {
    const candidate = (finalRef.current + " " + interimRef.current).trim();
    if (candidate) {
      onFinal?.(candidate);
      interimRef.current = "";
      finalRef.current = "";
    }
  }, [onFinal]);

  const resetSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) window.clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = window.setTimeout(() => {
      if (!endedRef.current) fireSilenceCommit();
    }, silenceMs);
  }, [fireSilenceCommit, silenceMs]);

  const start = useCallback(() => {
    if (typeof window === "undefined") return;
    const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { setError("unsupported"); return; }
    try {
      const rec = new SR();
      rec.lang = lang;
      rec.interimResults = true;
      rec.continuous = true;
      rec.onresult = (event: any) => {
        interimRef.current = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const r = event.results[i];
          if (r.isFinal) finalRef.current += r[0].transcript; else interimRef.current += r[0].transcript;
        }
        const combined = (finalRef.current + " " + interimRef.current).trim();
        if (combined) onInterim?.(combined);
        resetSilenceTimer();
      };
      rec.onend = () => {
        if (!endedRef.current) {
          // Chrome may stop randomly; auto-restart
          start();
        }
      };
      rec.onerror = () => {
        // soft error; try restart
        if (!endedRef.current) start();
      };
      recRef.current = rec;
      endedRef.current = false;
      setIsActive(true);
      rec.start();
    } catch (e: any) {
      setError(e?.message || "speech_error");
    }
  }, [lang, onInterim, resetSilenceTimer]);

  const stop = useCallback(() => {
    endedRef.current = true;
    setIsActive(false);
    try { recRef.current?.stop?.(); } catch {}
    if (silenceTimerRef.current) window.clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = null;
    // commit any residual text
    fireSilenceCommit();
  }, [fireSilenceCommit]);

  useEffect(() => () => stop(), [stop]);

  return { start, stop, isActive, error };
}


