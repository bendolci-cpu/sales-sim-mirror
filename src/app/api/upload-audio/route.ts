import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || !(file instanceof File)) {
      return new Response(JSON.stringify({ error: "missing file" }), { status: 400 });
    }
    const arrayBuffer = await file.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    const id = randomUUID();
    const dir = path.join(process.cwd(), "data", "audio");
    fs.mkdirSync(dir, { recursive: true });
    // pick extension based on mime
    const mime = (file as any).type || "audio/webm";
    const ext = mime.includes("mp3") ? ".mp3" : mime.includes("wav") ? ".wav" : ".webm";
    const target = path.join(dir, `${id}${ext}`);
    fs.writeFileSync(target, buf);
    return new Response(JSON.stringify({ audioUrl: `/api/audio/${id}` }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500 });
  }
}


