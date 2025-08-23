import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";

function resolveAudioPath(id: string) {
  const base = path.join(process.cwd(), "data", "audio", id);
  const mp3 = `${base}.mp3`;
  const wav = `${base}.wav`;
  if (fs.existsSync(mp3)) return { file: mp3, type: "audio/mpeg" } as const;
  if (fs.existsSync(wav)) return { file: wav, type: "audio/wav" } as const;
  return null;
}

function ensureDir(p: string) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

// Generate a 1-second sine WAV for test ids if missing
function maybeGenerateTestWav(id: string) {
  if (id !== "test-user" && id !== "test-ai") return null;
  const dir = path.join(process.cwd(), "data", "audio");
  ensureDir(dir);
  const file = path.join(dir, `${id}.wav`);
  if (fs.existsSync(file)) return { file, type: "audio/wav" } as const;
  const sampleRate = 44100;
  const durationSec = 1;
  const length = sampleRate * durationSec;
  const freq = id === "test-user" ? 440 : 660;
  const buffer = Buffer.alloc(44 + length * 2);
  // WAV header (PCM 16-bit mono)
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + length * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // audio format PCM
  buffer.writeUInt16LE(1, 22); // channels
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36);
  buffer.writeUInt32LE(length * 2, 40);
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const s = Math.sin(2 * Math.PI * freq * t);
    const sample = Math.max(-1, Math.min(1, s)) * 0.3; // reduce volume
    buffer.writeInt16LE(Math.floor(sample * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buffer);
  return { file, type: "audio/wav" } as const;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  let resolved = resolveAudioPath(id);
  if (!resolved) {
    const maybe = maybeGenerateTestWav(id);
    if (maybe) resolved = maybe;
  }
  if (!resolved) {
    return new Response("Not found", { status: 404 });
  }
  const stat = fs.statSync(resolved.file);
  const fileSize = stat.size;

  const range = req.headers.get("range");
  const headers: Record<string, string> = {
    "Content-Type": resolved.type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=0, must-revalidate",
  };

  if (range) {
    const match = /bytes=(\d+)-(\d+)?/.exec(range);
    const start = match ? parseInt(match[1], 10) : 0;
    const end = match && match[2] ? parseInt(match[2], 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    headers["Content-Range"] = `bytes ${start}-${end}/${fileSize}`;
    headers["Content-Length"] = String(chunkSize);
    const stream = fs.createReadStream(resolved.file, { start, end });
    return new Response(stream as unknown as ReadableStream, { status: 206, headers });
  }

  headers["Content-Length"] = String(fileSize);
  const stream = fs.createReadStream(resolved.file);
  return new Response(stream as unknown as ReadableStream, { status: 200, headers });
}


