/* src/app/api/upload-audio/route.ts */
import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const runtime = "nodejs";

const AUDIO_DIR = path.join(process.cwd(), "data", "audio");

async function ensureDir() {
  await fs.mkdir(AUDIO_DIR, { recursive: true });
}

// pick file extension by mime (default to webm if unknown)
function pickExt(mime: string | null | undefined) {
  if (!mime) return "webm";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("webm")) return "webm";
  return "webm";
}

export async function POST(req: NextRequest) {
  try {
    await ensureDir();
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: "missing file" }, { status: 400 });
    }
    const name = (form.get("name") as string) || "upload";
    const id = crypto.randomUUID();

    const ext = pickExt(file.type);
    const buf = Buffer.from(await file.arrayBuffer());
    const abs = path.join(AUDIO_DIR, `${id}.${ext}`);
    await fs.writeFile(abs, buf);

    // Optionally remember the ext so the GET route can find it (we'll just probe on GET)
    return NextResponse.json(
      {
        id,
        name,
        mime: file.type,
        size: buf.length,
        url: `/api/audio/${id}`,
      },
      {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      }
    );
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}