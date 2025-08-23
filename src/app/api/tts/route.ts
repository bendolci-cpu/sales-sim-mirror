import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(req: NextRequest) {
  try {
    const { text, voice = "alloy" } = await req.json();
    if (!text || typeof text !== "string") {
      return new Response(JSON.stringify({ error: "text required" }), { status: 400 });
    }
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "OPENAI_API_KEY not set" }), { status: 500 });
    }
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice,
        input: text,
        format: "mp3",
      }),
    });
    if (!r.ok) {
      const msg = await r.text();
      return new Response(JSON.stringify({ error: "tts failed", detail: msg }), { status: 500 });
    }
    const mp3 = await r.arrayBuffer();
    return new Response(Buffer.from(mp3), {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Accept-Ranges": "bytes",
      },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
  }
}


