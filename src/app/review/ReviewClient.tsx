"use client";
import { useEffect, useState } from "react";
import PlayCallButton from "@/components/PlayCallButton";

type Turn = { role: "user" | "assistant"; text?: string; audioUrl?: string | null; durationSec?: number };
type Review = { id: string; turns: Turn[] };

function SeedButton({ review, setReview }: { review: Review; setReview: (r: Review) => void }) {
  const onSeed = () => {
    const next: Review = { ...review, turns: [...(review.turns ?? [])] };
    const u = "/api/audio/test-user";
    const a = "/api/audio/test-ai";
    if (next.turns.length < 2) {
      next.turns.push({ role: "user", text: "seed user", audioUrl: u });
      next.turns.push({ role: "assistant", text: "seed ai", audioUrl: a });
    } else {
      next.turns[0] = { ...(next.turns[0] ?? { role: "user" as const }), audioUrl: u };
      next.turns[1] = { ...(next.turns[1] ?? { role: "assistant" as const }), audioUrl: a };
    }
    console.log("[Seed] new urls", next.turns.map(t => t.audioUrl));
    setReview(next);
  };
  if (process.env.NODE_ENV === "production") return null;
  return (
    <button onClick={onSeed} className="ml-3 rounded-lg bg-gray-100 px-3 py-2 text-gray-800 border shadow-sm hover:bg-gray-200">
      Seed Test Audio
    </button>
  );
}

function AudioDebug({ turns }: { turns: Turn[] }) {
  const rows = (turns || []).map((t, i) => ({ i, role: t.role, url: t.audioUrl ?? "—" }));
  console.log("[AudioDebug] urls", rows);
  return (
    <div className="rounded-xl border bg-white p-3 text-sm">
      {rows.length === 0 ? <div className="text-gray-500">No turns</div> : null}
      {rows.map(r => (
        <div key={r.i} className="py-0.5">
          #{r.i} <span className="font-mono">{r.role}</span> — <span className="font-mono">{r.url}</span>
        </div>
      ))}
    </div>
  );
}

export default function ReviewClient({ reviewId }: { reviewId: string }) {
  const [review, setReview] = useState<Review>({ id: reviewId || "unknown", turns: [] });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        if (!reviewId) {
          setReview({ id: "unknown", turns: [] });
        } else {
          const res = await fetch(`/api/reviews/${reviewId}`, { cache: "no-store" });
          if (!res.ok) throw new Error(`GET /api/reviews/${reviewId} -> ${res.status}`);
          const json = (await res.json()) as Review;
          if (live) setReview(json);
        }
      } catch (e: any) {
        if (live) setError(e?.message ?? "load error");
      } finally {
        if (live) setLoading(false);
      }
    }
    load();
    return () => { live = false; };
  }, [reviewId]);
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div className="flex items-center gap-3">
        <PlayCallButton turns={review.turns} />
        <SeedButton review={review} setReview={setReview} />
      </div>
      {loading && <div className="text-gray-500">Loading review…</div>}
      {error && <div className="text-red-600">Load error: {error}</div>}
      <AudioDebug turns={review.turns} />
      {/* Existing transcript UI could go here, using review.turns */}
    </div>
  );
}


