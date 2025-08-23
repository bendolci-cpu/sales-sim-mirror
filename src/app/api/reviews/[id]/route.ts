import { NextRequest, NextResponse } from "next/server";
import { loadReview, saveReview, type Review } from "@/lib/reviews";

export const runtime = "nodejs";

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const r = loadReview(params.id);
  if (!r) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(r, { status: 200, headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json();
  const turns = (body?.turns ?? []).filter((t: any) => t && t.role && t.text !== undefined);
  const review: Review = { id: params.id, createdAt: Date.now(), turns };
  saveReview(review);
  return NextResponse.json({ ok: true, id: params.id, turns: review.turns.length });
}

import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile, mkdir } from "fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function getPath(id: string) {
  const dir = path.join(process.cwd(), "data", "reviews");
  const p = path.join(dir, `${id}.json`);
  return { dir, p } as const;
}

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!id) return new Response("Missing id", { status: 400 });
  try {
    const { p } = getPath(id);
    const buf = await readFile(p);
    return new NextResponse(buf, { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store, max-age=0" } });
  } catch {
    // Return empty review if not found
    return NextResponse.json({ id, turns: [] }, { status: 200, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!id) return new Response("Missing id", { status: 400 });
  try {
    const body = await req.text();
    const { dir, p } = getPath(id);
    await mkdir(dir, { recursive: true });
    await writeFile(p, Buffer.from(body));
    return NextResponse.json({ ok: true, id });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}


