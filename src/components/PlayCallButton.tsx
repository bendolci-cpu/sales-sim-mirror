"use client";

import React, { useRef, useState } from "react";

type Turn = { role?: "user" | "assistant"; audioUrl?: string | null };

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(url, { credentials: "include", cache: "no-store" });
    if (!res.ok) {
      console.warn("[PlayCall] fetch failed", url, res.status, res.statusText);
      return null;
    }
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("audio")) {
      console.warn("[PlayCall] non-audio content-type", url, ct);
    }
    const buf = await res.arrayBuffer();
    if (!buf.byteLength) {
      console.warn("[PlayCall] empty audio buffer", url);
      return null;
    }
    return buf;
  } catch (e) {
    console.error("[PlayCall] fetch error", url, e);
    return null;
  }
}

async function concatBuffers(buffers: AudioBuffer[]): Promise<AudioBuffer> {
  const sampleRate = buffers[0]?.sampleRate || 44100;
  const totalLength = buffers.reduce((sum, b) => sum + (b?.length || 0), 0);
  const offline = new OfflineAudioContext(1, totalLength, sampleRate);
  let offset = 0;
  for (const b of buffers) {
    if (!b) continue;
    const src = offline.createBufferSource();
    src.buffer = b;
    src.connect(offline.destination);
    src.start(offset / sampleRate);
    offset += b.length;
  }
  const merged = await offline.startRendering();
  return merged;
}

export default function PlayCallButton({ turns }: { turns: Turn[] }) {
  const [isPlaying, setIsPlaying] = useState(false);

  const playSeq = async () => {
    if (isPlaying) return;
    setIsPlaying(true);
    const urls = (turns || []).map(t => t.audioUrl).filter((u): u is string => !!u);
    for (const url of urls) {
      try {
        const a = new Audio(url);
        await new Promise<void>((resolve) => {
          a.onerror = () => resolve();
          a.onended = () => resolve();
          a.play().catch(() => resolve());
        });
      } catch {}
    }
    setIsPlaying(false);
  };

  return (
    <button
      onClick={playSeq}
      disabled={isPlaying}
      className="rounded-lg bg-blue-600 px-4 py-2 text-white shadow hover:bg-blue-700 disabled:opacity-50"
    >
      {isPlaying ? "Playing…" : "Play Call"}
    </button>
  );
}



