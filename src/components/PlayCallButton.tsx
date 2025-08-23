"use client";

import { useState } from "react";

export type Turn = { role: "user" | "assistant"; text: string; audioUrl?: string };

export default function PlayCallButton({ turns }: { turns: Turn[] }) {
  const [playing, setPlaying] = useState(false);

  async function handlePlay() {
    if (playing) return;
    setPlaying(true);
    try {
      const urls = turns.map(t => t.audioUrl ?? "/api/audio/test-ai");
      console.log("[PlayCall] urls", urls);

      for (const url of urls) {
        try {
          const r = await fetch(url, { cache: "no-store" });
          const blob = await r.blob();
          console.log("[PlayCall] fetched", url, "size", blob.size, "type", blob.type);
          if (blob.size === 0) continue;

          const src = URL.createObjectURL(blob);
          const a = new Audio(src);
          a.volume = 1.0;
          a.playbackRate = 1.0;
          await a.play();
          await new Promise(res => (a.onended = res));
          URL.revokeObjectURL(src);
        } catch (e) {
          console.error("[PlayCall] failed for", url, e);
        }
      }
    } finally {
      setPlaying(false);
    }
  }

  return (
    <button
      onClick={handlePlay}
      disabled={playing}
      className="px-4 py-2 bg-blue-600 text-white rounded"
    >
      {playing ? "Playing..." : "Play Call"}
    </button>
  );
}