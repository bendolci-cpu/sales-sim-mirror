"use client";
import { useMemo, useState } from "react";

export type Turn = { role: "user" | "assistant"; text: string; audioUrl?: string | null };

function playOnce(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url);
    audio.volume = 1.0;
    audio.playbackRate = 1.0;
    audio.addEventListener("ended", () => resolve(), { once: true });
    audio.addEventListener("error", () => reject(new Error("audio error")), { once: true });
    audio.play().catch(reject);
  });
}

async function playSequentially(urls: string[]) {
  for (const url of urls) {
    try { await playOnce(url); } catch (e) { console.warn("[PlayCall] skip", url, e); }
  }
}

export default function PlayCallButton({ turns }: { turns: Turn[] }) {
  const [playing, setPlaying] = useState(false);
  const turnsWithAudio = useMemo(() => (turns || []).filter(t => !!t.audioUrl), [turns]);

  async function handlePlay() {
    if (playing || turnsWithAudio.length === 0) return;
    setPlaying(true);
    try {
      const urls = turnsWithAudio.map(t => t.audioUrl!);
      console.log("[PlayCall] urls", urls);
      await playSequentially(urls);
    } finally {
      setPlaying(false);
    }
  }

  return (
    <button onClick={handlePlay} disabled={playing || turnsWithAudio.length === 0}
      title={turnsWithAudio.length === 0 ? "No audio for this review" : undefined}
      className="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50">
      {playing ? "Playing..." : "Play Call"}
    </button>
  );
}