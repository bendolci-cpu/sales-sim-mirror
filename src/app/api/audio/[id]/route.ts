// app/api/audio/[id]/route.ts
import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export const runtime = "nodejs";

function audioMp3Path(id: string) {
  return path.join(process.cwd(), "data", "audio", `${id}.mp3`);
}

// Generate a 1s 440Hz WAV (16-bit PCM, 44.1kHz)
function generateTestWav(durationSec = 1, freq = 440): Buffer {
  const sampleRate = 44100;
  const numSamples = Math.floor(durationSec * sampleRate);
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const riffSize = 36 + dataSize;

  const buffer = Buffer.alloc(44 + dataSize);
  let o = 0;
  // RIFF header
  buffer.write("RIFF", o); o += 4;
  buffer.writeUInt32LE(riffSize, o); o += 4;
  buffer.write("WAVE", o); o += 4;
  // fmt  chunk
  buffer.write("fmt ", o); o += 4;
  buffer.writeUInt32LE(16, o); o += 4;                 // PCM chunk size
  buffer.writeUInt16LE(1, o); o += 2;                  // PCM
  buffer.writeUInt16LE(numChannels, o); o += 2;
  buffer.writeUInt32LE(sampleRate, o); o += 4;
  buffer.writeUInt32LE(byteRate, o); o += 4;
  buffer.writeUInt16LE(blockAlign, o); o += 2;
  buffer.writeUInt16LE(bitsPerSample, o); o += 2;
  // data chunk
  buffer.write("data", o); o += 4;
  buffer.writeUInt32LE(dataSize, o); o += 4;

  // Samples
  const amp = 0.3 * 0x7fff;
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const s = Math.sin(2 * Math.PI * freq * t);
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.floor(amp * s))), 44 + i * 2);
  }
  return buffer;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const filePath = audioMp3Path(params.id);

  if (fs.existsSync(filePath)) {
    // Serve existing MP3 (supports Range)
    const stat = fs.statSync(filePath);
    const range = req.headers.get("range");
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m?.[1] ? parseInt(m[1], 10) : 0;
      const end = m?.[2] ? parseInt(m[2], 10) : stat.size - 1;
      const chunk = fs.createReadStream(filePath, { start, end });
      return new NextResponse(chunk as any, {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
          "Content-Type": "audio/mpeg",
          "Cache-Control": "no-store",
        },
      });
    }
    const stream = fs.createReadStream(filePath);
    return new NextResponse(stream as any, {
      status: 200,
      headers: {
        "Content-Length": String(stat.size),
        "Content-Type": "audio/mpeg",
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      },
    });
  }

  // Fallback: return a valid 1s WAV tone (works in any browser)
  const wav = generateTestWav(1, 440);
  return new NextResponse(wav, {
    status: 200,
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(wav.length),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    },
  });
}