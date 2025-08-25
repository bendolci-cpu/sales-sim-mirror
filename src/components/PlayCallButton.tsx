"use client";

import { useState } from "react";
import {mic} from "../lib/mic";

export type Turn = {
  role: "user" | "assistant";
  text: string;
  url?: string;        // optional
  audioUrl?: string;   // optional alias
};

async function uploadAudio(blob: Blob, name: string) {
  const fd = new FormData();
  fd.append("file", blob, `${name}.webm`);
  const r = await fetch("/api/upload-audio", { method: "POST", body: fd, cache: "no-store" });
  if (!r.ok) throw new Error(`/api/upload-audio failed: ${r.status}`);
  const json = await r.json();
  if (!json?.url) throw new Error("upload response missing url");
  return json as { url: string };
}

export default function PlayCallButton({
  reviewId,
  turns,
}: {
  reviewId: string;
  turns: Turn[];
}) {
  const [playing, setPlaying] = useState(false);

  async function handlePlay() {
    if (playing) return;
    setPlaying(true);

    // 1) Start mic so you capture yourself while the assistant plays
    try {
      // First ensure mic stream is active
      await mic.start();
      await mic.startRecording();
      console.log("[PlayCall] mic started");
    } catch (e) {
      console.warn("[PlayCall] mic start failed (continuing playback anyway)", e);
    }

    // 2) Play ASSISTANT clips while we record the mic
try {
  const assistantUrls = turns
    .filter(t => t.role === "assistant")
    .map(t => t.url ?? t.audioUrl ?? "/api/audio/test-ai");

  console.log("[PlayCall] assistant urls", assistantUrls);

  for (const url of assistantUrls) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      const blob = await r.blob();
      if (blob.size === 0) continue;

      const src = URL.createObjectURL(blob);
      const a = new Audio(src);
      a.volume = 1.0;
      a.playbackRate = 1.0;
      await a.play();
      await new Promise(res => (a.onended = res));
      URL.revokeObjectURL(src);
    } catch (e) {
      console.error("[PlayCall] assistant fetch/play failed", url, e);
    }
  }
} finally {
  // 3) Stop mic and upload what we captured
  try {
    const rec = await mic.stopRecording();
    console.log("[PlayCall] mic stopped", rec ? { size: rec.size, type: rec.type } : null);

    if (rec && rec.size > 0) {
      const { url } = await uploadAudio(rec, "user");
      console.log("[PlayCall] uploaded mic url", url);

      // Attach to the first USER turn and persist the review
      const idx = turns.findIndex(t => t.role === "user");
      if (idx >= 0) {
        turns[idx] = { ...turns[idx], url, audioUrl: url };
      }

      await fetch(`/api/reviews/${reviewId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: reviewId, createdAt: Date.now(), turns }),
      });
      console.log("[PlayCall] review updated with user audio");

      // 4) Optional: play your own clip back so you hear yourself
      try {
        const a2 = new Audio(url);
        a2.volume = 1.0;
        await a2.play();
        await new Promise(res => (a2.onended = res));
      } catch (e) {
        console.warn("[PlayCall] self-monitor playback failed", e);
      }
    } else {
      console.warn("[PlayCall] no mic recording available");
    }
  } catch (e) {
    console.warn("[PlayCall] mic upload/save failed", e);
  }

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