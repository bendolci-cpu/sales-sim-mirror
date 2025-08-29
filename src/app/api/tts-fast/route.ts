import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import path from "path";
import { mkdir, writeFile } from "fs/promises";

type TtsBody = { text?: string; voice?: string; format?: "mp3" | "wav" };

export const runtime = "nodejs";
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

    // Use faster model and optimized settings
    const resp = await openai.audio.speech.create({
      model: "tts-1", // Faster than gpt-4o-mini-tts
      voice,
      input: text,
      response_format: outFmt,
      speed: 1.1, // Slightly faster playback
    });

    const arrayBuf = await resp.arrayBuffer();
    const buf = Buffer.from(arrayBuf);

    // Track TTS usage (rough estimate: 1 token per ~4 characters)
    const estimatedTokens = Math.ceil(text.length / 4);
    try {
      await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/api/budget/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'tts-1',
          usage: {
            prompt_tokens: estimatedTokens,
            completion_tokens: 0,
            total_tokens: estimatedTokens
          }
        })
      });
    } catch (e) {
      console.warn('Failed to track TTS budget usage:', e);
    }

    const uploadsDir = path.join(process.cwd(), "public", "uploads");
    await mkdir(uploadsDir, { recursive: true });

    const fname = `aud-${Date.now()}.${outFmt}`;
    await writeFile(path.join(uploadsDir, fname), buf);

    return NextResponse.json(
      { 
        url: `/uploads/${fname}`,
        size: buf.length,
        optimized: true
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (e: any) {
    const msg = typeof e?.message === "string" ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
