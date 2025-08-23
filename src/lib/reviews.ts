import fs from "node:fs";
import path from "node:path";

export type Turn = { role: "user" | "assistant"; text: string; audioUrl?: string };
export type Review = { id: string; createdAt: number; turns: Turn[] };

const ROOT = path.join(process.cwd(), "data", "reviews");
function ensureDir() { if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true }); }
function filePath(id: string) { return path.join(ROOT, `${id}.json`); }

export function saveReview(r: Review) {
  ensureDir();
  fs.writeFileSync(filePath(r.id), JSON.stringify(r, null, 2), "utf8");
}

export function loadReview(id: string): Review | null {
  try {
    const raw = fs.readFileSync(filePath(id), "utf8");
    const r = JSON.parse(raw) as Review;
    if (!Array.isArray(r.turns)) r.turns = [];
    return r;
  } catch { return null; }
}


