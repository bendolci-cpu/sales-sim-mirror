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
 * Never returns 500 - only 404 for missing files
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  try {
    await ensureDir();
    const txt = await fs.readFile(fileFor(id), "utf8");
    const json = JSON.parse(txt);
    // no-store so Review page always fetches fresh
    return NextResponse.json(json, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // Always return 404, never 500
    console.log(`[API] Review ${id} not found:`, error);
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}

/**
 * POST /api/reviews/[id]
 * Body: { createdAt?: number, turns: Array<{role:"user"|"assistant", text:string, url?:string}> }
 * Creates or updates the review file. Never returns 500.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  try {
    await ensureDir();
    const body = await req.json();

    // Normalize and persist url field so the Review page can play clips
    const turns = Array.isArray(body?.turns)
      ? body.turns.map((t: any) => ({
          role: t.role,
          text: t.text ?? "",
          url: t.url ?? t.audioUrl ?? null, // Support both url and audioUrl for backward compatibility
        }))
      : [];

    const payload = {
      id,
      createdAt: body?.createdAt ?? Date.now(),
      turns,
    };

    await fs.writeFile(fileFor(id), JSON.stringify(payload, null, 2), "utf8");
    return NextResponse.json({ ok: true, data: payload }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    // Log error but return 400 instead of 500
    console.error(`[API] Failed to save review ${id}:`, err);
    return NextResponse.json({ error: "Invalid request data" }, { status: 400 });
  }
}