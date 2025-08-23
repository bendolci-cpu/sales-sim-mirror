// src/app/api/tts/route.ts
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const text = (body?.text ?? "").toString();
    if (!text) {
      return NextResponse.json({ error: "missing text" }, { status: 400 });
    }
    // Temporary stub: always return the seeded assistant clip
    return NextResponse.json({ url: "/api/audio/test-ai" }, { status: 200 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}