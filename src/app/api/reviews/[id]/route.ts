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

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { p } = getPath(params.id);
    const buf = await readFile(p);
    return new NextResponse(buf, { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store, max-age=0" } });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await req.text();
    const { dir, p } = getPath(params.id);
    await mkdir(dir, { recursive: true });
    await writeFile(p, Buffer.from(body));
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}


