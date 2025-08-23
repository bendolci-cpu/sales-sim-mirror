"use client";

import { useState } from "react";
import mic from "@/mic";

// NOTE: Keep this type in sync with the rest of your app.
export type Turn = { role: "user" | "assistant"; text: string; audioUrl?: string };

/** POST a blob to /api/upload-audio and return the URL the API responds with. */
async function uploadClip(blob: Blob, name: string) {
  const fd = new FormData();
  fd.append("file", blob, `${name}.webm`);
  const res = await fetch("/api/upload-audio", { method: "POST", body: fd, cache: "no-store" });
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
  const json = await res.json().catch(() => ({}));
  if (!json?.url) throw new Error("upload response missing url");
  return json.url as string;
}

export default function PlayCallButton({ turns }: { turns: Turn[] }) {
  const [playing, setPlaying] = useState(false);

  async function handlePlay() {
    if (playing) return;
    setPlaying(true);

    // 1) Start mic capture before playback so you can hear yourself + the AI.
    try {
      await mic.startRecording("user");
      console.log("[PlayCall] mic started");
    } catch (e) {
      console.warn("[PlayCall] mic start failed (continuing playback anyway)", e);
    }

    try {
      // 2) Build the list of URLs to play (fallbacks for missing ones).
      const urls = turns.map((t) => t.audioUrl ?? (t.role === "assistant" ? "/api/audio/test-ai" : "/api/audio/test-user"));
      console.log("[PlayCall] urls", urls);

      // 3) Fetch and play each clip in order.
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
      // 4) Stop mic and upload what we captured.
      try {
        const rec = await mic.stopRecording();
        if (rec) {
          console.log("[PlayCall] mic stopped, size", rec.size, "type", rec.type);
          try {
            const url = await uploadClip(rec, "user");
            console.log("[PlayCall] uploaded mic clip:", url);
          } catch (e) {
            console.error("[PlayCall] mic upload failed", e);
          }
        } else {
          console.log("[PlayCall] no mic recording available");
        }
      } catch (e) {
        console.warn("[PlayCall] stopping mic failed", e);
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