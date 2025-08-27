import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";

export const runtime = "nodejs"; // we use fs

// Folder and file path helpers
const ROOT = path.join(process.cwd(), "data", "reviews");
const fileFor = (id: string) => path.join(ROOT, `${id}.json`);

async function ensureDir() {
  await fs.mkdir(ROOT, { recursive: true });
}

/**
 * GET /api/reviews/[id]
 * Returns { id, createdAt, turns } or 404 if missing
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await ctx.params;
    await ensureDir();
    const txt = await fs.readFile(fileFor(id), "utf8");
    const json = JSON.parse(txt);
    // no-store so Review page always fetches fresh
    return NextResponse.json(json, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}

/**
 * POST /api/reviews/[id]
 * Body: { createdAt?: number, turns: Array<{role:"user"|"assistant", text:string, audioUrl?:string}> }
 * Upserts the file.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await ctx.params;
    await ensureDir();
    const body = await req.json();

    // normalize and persist url/audioUrl so the Review page can play clips
const turns = Array.isArray(body?.turns)
? body.turns.map((t: any) => ({
    role: t.role,
    text: t.text ?? "",
    url: t.url ?? t.audioUrl ?? null,
    audioUrl: t.audioUrl ?? t.url ?? null,
  }))
: [];

const payload = {
id,
createdAt: body?.createdAt ?? Date.now(),
turns,
};

    await fs.writeFile(fileFor(id), JSON.stringify(payload, null, 2), "utf8");
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}