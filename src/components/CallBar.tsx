"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import MicViz from "@/components/call/MicViz";

export type CallBarProps = {
  state: "idle" | "ringing" | "connected" | "ended";
  onCall: () => void;
  onEnd: () => void;
  stream?: MediaStream | null;
  isInitializing?: boolean;
};

export default function CallBar({ state, onCall, onEnd, stream, isInitializing = false }: CallBarProps) {
  const [elapsed, setElapsed] = useState<number>(0);
  const startedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (state === "connected") {
      if (!startedAtRef.current) startedAtRef.current = Date.now();
      const id = setInterval(() => setElapsed(Math.floor(((Date.now() - (startedAtRef.current || Date.now())) / 1000))), 250);
      return () => clearInterval(id);
    }
    if (state !== "connected") { startedAtRef.current = null; setElapsed(0); }
  }, [state]);

  const mmss = useMemo(() => {
    const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const ss = String(elapsed % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }, [elapsed]);

  const pill = (() => {
    if (state === "idle") return <span className="rounded-full border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-700" aria-live="polite">Idle</span>;
    if (state === "ringing") return <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800" aria-live="polite"><span className="h-1.5 w-1.5 animate-ping rounded-full bg-amber-500"/>Ringing</span>;
    if (state === "connected") return <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800" aria-live="polite"><span className="h-1.5 w-1.5 animate-ping rounded-full bg-emerald-500"/>Connected</span>;
    return <span className="rounded-full border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-500" aria-live="polite">Ended</span>;
  })();

  return (
    <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-4 py-2">
      <div className="flex items-center gap-3">
        {pill}
        <span className="text-xs text-gray-500" aria-live="polite">{mmss}</span>
      </div>
      <div className="flex items-center gap-3">
        <MicViz active={state === "connected"} stream={stream} />
        {state === "idle" || state === "ended" ? (
          <button 
            onClick={onCall} 
            disabled={isInitializing}
            className={`rounded-xl px-4 py-2 text-sm text-white shadow ${
              isInitializing 
                ? 'bg-gray-400 cursor-not-allowed' 
                : 'bg-emerald-600 hover:bg-emerald-700'
            }`}
          >
            {isInitializing ? 'Initializing...' : 'Call'}
          </button>
        ) : state === "ringing" ? (
          <button onClick={onEnd} className="rounded-xl bg-rose-600 px-4 py-2 text-sm text-white shadow hover:bg-rose-700">End Call</button>
        ) : (
          <button onClick={onEnd} className="rounded-xl bg-rose-600 px-4 py-2 text-sm text-white shadow hover:bg-rose-700">End Call</button>
        )}
      </div>
    </div>
  );
}


