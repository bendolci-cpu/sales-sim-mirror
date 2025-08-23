"use client";

import { useState } from "react";
import mic from "@/lib/mic";

export type Turn = { role: "user" | "assistant"; text: string; audioUrl?: string };

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
      await mic.startRecording("user");
      console.log("[PlayCall] mic started");
    } catch (e) {
      console.warn("[PlayCall] mic start failed (continuing playback anyway)", e);
    }

    try {
      // 2) Build URLs to play in order; fallback to test clips for any missing urls
      const urls = turns.map((t) =>
        t.audioUrl ?? (t.role === "assistant" ? "/api/audio/test-ai" : "/api/audio/test-user")
      );
      console.log("[PlayCall] urls", urls);

      // 3) Fetch and play each clip sequentially
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
          await new Promise((res) => (a.onended = res));
          URL.revokeObjectURL(src);
        } catch (e) {
          console.error("[PlayCall] failed for", url, e);
        }
      }
    } finally {
      // 4) Stop mic and upload what we captured; save to the USER turn; persist review
      try {
        const rec = await mic.stopRecording();
        console.log("[PlayCall] mic stopped", rec ? { size: rec.size, type: rec.type } : null);

        if (rec && rec.size > 0) {
          const { url } = await uploadAudio(rec, "user");
          console.log("[PlayCall] uploaded mic url", url);

          // find first user turn and attach the url
          const idx = turns.findIndex((t) => t.role === "user");
          if (idx >= 0) turns[idx] = { ...turns[idx], audioUrl: url };

          // persist the updated turns to the review
          await fetch(`/api/reviews/${reviewId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: reviewId, createdAt: Date.now(), turns }),
          });
          console.log("[PlayCall] review updated with user audio");
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