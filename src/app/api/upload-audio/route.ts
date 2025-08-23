import { NextRequest, NextResponse } from "next/server";
import { mkdir, writeFile } from "fs/promises";
import path from "node:path";

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "no file" }, { status: 400 });
    }
    const id = crypto.randomUUID();
    const buf = Buffer.from(await file.arrayBuffer());
    const mime = (file as any).type || "audio/webm";
    const ext = mime.includes("mpeg") || mime.includes("mp3") ? "mp3" : mime.includes("wav") ? "wav" : "webm";
    const dir = path.join(process.cwd(), "data", "audio");
    await mkdir(dir, { recursive: true });
    // If MP3, save as mp3; otherwise save with original ext (best-effort; transcoding omitted for now)
    const p = path.join(dir, `${id}.${ext}`);
    await writeFile(p, buf);
    console.log(`[UploadAudio] saved ${id}.${ext}`);
    return NextResponse.json({ audioUrl: `/api/audio/${id}` });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}


