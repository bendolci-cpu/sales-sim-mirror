// src/app/api/reviews/[id]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";

export const runtime = "nodejs";

const ROOT = path.join(process.cwd(), "data", "reviews");
const fileFor = (id: string) => path.join(ROOT, `${id}.json`);

async function ensureDir() {
  await fs.mkdir(ROOT, { recursive: true });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await ensureDir();
    const txt = await fs.readFile(fileFor(params.id), "utf8");
    const json = JSON.parse(txt);
    return NextResponse.json(json, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await ensureDir();
    const body = await req.json();

    const turns = Array.isArray(body.turns) ? body.turns : [];
    const payload = {
      id: params.id,
      createdAt: body.createdAt ?? Date.now(),
      turns,
    };

    await fs.writeFile(fileFor(params.id), JSON.stringify(payload, null, 2), "utf8");
    return NextResponse.json(payload, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}