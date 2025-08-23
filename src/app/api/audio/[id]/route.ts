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

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const resolved = resolveAudioPath(id);
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


