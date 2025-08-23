/* src/app/api/audio/[id]/route.ts */
import { NextRequest, NextResponse } from "next/server";
import { promises as fs, createReadStream } from "node:fs";
import fssync from "node:fs";
import path from "node:path";

export const runtime = "nodejs";

// try these extensions in order
const CANDIDATE_EXTS = ["webm", "wav", "mp3"];

const AUDIO_DIR = path.join(process.cwd(), "data", "audio");

function resolveExisting(id: string) {
  for (const ext of CANDIDATE_EXTS) {
    const abs = path.join(AUDIO_DIR, `${id}.${ext}`);
    if (fssync.existsSync(abs)) return { abs, ext };
  }
  return null;
}

function contentType(ext: string) {
  if (ext === "wav") return "audio/wav";
  if (ext === "mp3") return "audio/mpeg";
  // default
  return "audio/webm";
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const found = resolveExisting(params.id);
    if (!found) {
      return new NextResponse("Not Found", { status: 404 });
    }

    const stat = await fs.stat(found.abs);
    const range = req.headers.get("range");
    const ct = contentType(found.ext);

    // Range support
    if (range) {
      const m = /bytes=(\d+)-(\d+)?/.exec(range);
      if (!m) return new NextResponse("Malformed Range", { status: 416 });

      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      const chunk = createReadStream(found.abs, { start, end });

      return new NextResponse(chunk as any, {
        status: 206,
        headers: {
          "Content-Type": ct,
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Cache-Control": "no-store",
        },
      });
    }

    // Full-body
    const stream = createReadStream(found.abs);
    return new NextResponse(stream as any, {
      status: 200,
      headers: {
        "Content-Type": ct,
        "Content-Length": String(stat.size),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return new NextResponse(String(e), { status: 500 });
  }
}