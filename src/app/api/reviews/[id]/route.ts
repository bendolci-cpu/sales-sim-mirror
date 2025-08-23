import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export const runtime = "nodejs";

type Turn = { role: "user" | "assistant"; text: string; audioUrl?: string };
type Review = { id: string; createdAt: number; turns: Turn[] };

const ROOT = path.join(process.cwd(), "data", "reviews");
const filePath = (id: string) => path.join(ROOT, `${id}.json`);

function ensureDir() {
  if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true });
}
function loadReview(id: string): Review | null {
  try {
    const raw = fs.readFileSync(filePath(id), "utf8");
    const r = JSON.parse(raw) as Review;
    if (!Array.isArray(r.turns)) r.turns = [];
    return r;
  } catch {
    return null;
  }
}
function saveReview(r: Review) {
  ensureDir();
  fs.writeFileSync(filePath(r.id), JSON.stringify(r, null, 2), "utf8");
}

export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  const r = loadReview(ctx.params.id);
  if (!r) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  let body: any;
  try { body = await req.json(); } catch { body = {}; }

  const turns = Array.isArray(body?.turns)
    ? body.turns.filter((t: any) => t?.role && "text" in t)
    : [];

  const review: Review = { id: ctx.params.id, createdAt: Date.now(), turns };
  saveReview(review);

  return NextResponse.json({ ok: true, id: review.id, turns: review.turns.length });
}