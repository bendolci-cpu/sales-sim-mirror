"use client";

import React, { useMemo, useState } from "react";

type Turn = { role?: "user" | "assistant"; audioUrl?: string | null };

export default function PlayCallButton({ turns }: { turns: Turn[] }) {
  const urls = useMemo(() => (turns || []).map(t => t.audioUrl ?? "/api/audio/test-ai"), [turns]);
  const [busy, setBusy] = useState(false);

  const handlePlay = async () => {
    if (busy || urls.length === 0) return;
    setBusy(true);
    console.log("[PlayCall] urls", urls);
    try {
      for (const u of urls) {
        try {
          const res = await fetch(u, { credentials: "include", cache: "no-store" });
          if (!res.ok) { console.warn("[PlayCall] fetch !ok", u, res.status); continue; }
          const blob = await res.blob();
          console.log("[PlayCall] fetched", u, "size", blob.size, "type", blob.type);
          const obj = URL.createObjectURL(blob);
          const audio = new Audio(obj);
          audio.volume = 1.0;
          audio.playbackRate = 1.0;
          await new Promise<void>((resolve) => {
            audio.onended = () => resolve();
            audio.onerror = () => { console.warn("[PlayCall] audio error", u); resolve(); };
            audio.play().catch(err => { console.warn("[PlayCall] play() reject", err); resolve(); });
          });
          URL.revokeObjectURL(obj);
        } catch (e) {
          console.warn("[PlayCall] skip", u, e);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={handlePlay}
      disabled={busy || urls.length === 0}
      title={urls.length === 0 ? "No audio attached to this review" : undefined}
      className="rounded-lg bg-blue-600 px-4 py-2 text-white shadow hover:bg-blue-700 disabled:opacity-50"
    >
      {busy ? "Playing…" : "Play Call"}
    </button>
  );
}



