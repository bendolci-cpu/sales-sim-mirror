import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import path from "path";
import { mkdir, writeFile } from "fs/promises";

type TtsBody = { text?: string; voice?: string; format?: "mp3" | "wav" };

// IMPORTANT: run this route on Node.js so fs/path work
export const runtime = "nodejs";

// (optional but helpful so the Review page fetches fresh)
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as TtsBody;
    const text = (body.text ?? "").toString().trim();
    const voice = (body.voice ?? "alloy").toString();
    const outFmt = ((body.format ?? "mp3") === "wav" ? "wav" : "mp3") as "mp3" | "wav";

    if (!text) {
      return NextResponse.json({ error: "missing text" }, { status: 400 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "missing OPENAI_API_KEY" }, { status: 500 });
    }

    const openai = new OpenAI({ apiKey });

    const resp = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice,
      input: text,
      format: outFmt,
    });

    const arrayBuf = await resp.arrayBuffer();
    const buf = Buffer.from(arrayBuf);

    const uploadsDir = path.join(process.cwd(), "public", "uploads");
    await mkdir(uploadsDir, { recursive: true });

    const fname = `aud-${Date.now()}.${outFmt}`;
    await writeFile(path.join(uploadsDir, fname), buf);

    return NextResponse.json(
      { url: `/uploads/${fname}` },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (e: any) {
    const msg = typeof e?.message === "string" ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
