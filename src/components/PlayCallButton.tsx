"use client";

import React, { useState } from "react";

type Turn = { audioUrl?: string | null };

export default function PlayCallButton({ turns }: { turns: Turn[] }) {
  const [isPlaying, setIsPlaying] = useState(false);

  const handlePlay = async () => {
    if (isPlaying) return;
    setIsPlaying(true);

    const urls = turns.map(t => t.audioUrl).filter((u): u is string => Boolean(u));

    for (const url of urls) {
      try {
        const audio = new Audio(url);
        await new Promise<void>((resolve) => {
          audio.onended = () => resolve();
          audio.onerror = () => resolve();
          const playPromise = audio.play();
          if (playPromise && typeof playPromise.then === "function") {
            playPromise.catch(() => resolve());
          }
        });
      } catch {
        // skip errors
      }
    }

    setIsPlaying(false);
  };

  return (
    <button
      onClick={handlePlay}
      disabled={isPlaying}
      className="rounded-lg bg-blue-600 px-4 py-2 text-white shadow hover:bg-blue-700 disabled:opacity-50"
    >
      {isPlaying ? "Playing…" : "Play Call"}
    </button>
  );
}


