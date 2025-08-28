// src/app/review/page.tsx
// IMPORTANT: This is a SERVER COMPONENT that should NEVER initialize mic, web-speech, or LiveKit
// All audio playback is handled by the client-only ReviewPlayer component
export const dynamic = "force-dynamic"; // always fetch fresh

import Link from "next/link";
import ReviewPlayer from "./ReviewPlayer";
import { headers } from "next/headers";

/** ----- Types ----- */
type Turn = {
  role: "user" | "assistant";
  text?: string;
  url?: string | null;
  audioUrl?: string | null;
};

type ReviewJSON = {
  id: string;
  createdAt: number;
  turns: Turn[];
};

type GetRes =
  | { ok: true; status: number; data: ReviewJSON; err: null }
  | { ok: false; status: number; data: null; err: string };

/** ----- Helpers ----- */

async function getReview(id: string): Promise<GetRes> {
  try {
    const hdrs = await headers();
    const host = hdrs.get("host") ?? "localhost:3000";
    const proto = host.startsWith("localhost") ? "http" : "https";
    const base = process.env.NEXT_PUBLIC_BASE_URL ?? `${proto}://${host}`;
    const res = await fetch(`${base}/api/reviews/${id}`, { cache: "no-store" });
    if (!res.ok) {
      return { ok: false, status: res.status, data: null, err: await res.text() };
    }
    const json = (await res.json()) as ReviewJSON;
    return { ok: true, status: 200, data: json, err: null };
  } catch (e: any) {
    return { ok: false, status: 500, data: null, err: String(e) };
  }
}

function Transcript({ turns }: { turns: { role: "user" | "assistant"; text: string; url?: string | null; audioUrl?: string | null }[] }) {
  if (!turns.length) {
    return (
      <div className="mt-2 text-slate-400 opacity-60">
        No turns saved for this review.
      </div>
    );
  }

  return (
    <div className="space-y-2 mt-4">
      {turns.map((t, i) => (
        <div key={i}>
          <div className="inline-flex items-center gap-2">
            <span className="px-2 py-0.5 rounded-lg bg-slate-800 text-slate-100">
              {t.role}
            </span>
            <span className="uppercase tracking-wide opacity-60 text-[11px]">
              {t.url ? "has audio" : "no audio"}
            </span>
            {t.url && (
              <span className="text-xs text-slate-400 font-mono">
                {t.url}
              </span>
            )}
          </div>
          <div className="whitespace-pre-wrap mt-1 text-slate-200">
            {t.text ?? <span className="opacity-60">— no text —</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** ----- Page ----- */
// NOTE: in Next 14+ searchParams is a Promise — we MUST await it.
export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const params = await searchParams; // ← important
  const id = params.id ?? "";
  const seed = params.seed ?? "";

  /* Missing id guard */
  if (!id) {
    return (
      <main className="mx-auto max-w-3xl text-slate-100 p-6">
        <div className="mb-4">
          <Link href="/" className="underline text-slate-300">
            Back to Dashboard
          </Link>
        </div>
        <div className="text-red-400">Missing review id.</div>
      </main>
    );
  }

  /* Try to load the review */
  let res = await getReview(id);

  /* If missing AND ?seed=1, create a tiny starter review then re-fetch */
  if (!res.ok && seed === "1") {
    const body: ReviewJSON = {
      id,
      createdAt: Date.now(),
      turns: [
        { role: "user", text: "check one two", url: "/api/audio/test-user" },
        { role: "assistant", text: "roger that", url: "/api/audio/test-ai" },
      ],
    };

    const hdrs2 = await headers();
    const host = hdrs2.get("host") ?? "localhost:3000";
    const proto = host.startsWith("localhost") ? "http" : "https";
    const base = process.env.NEXT_PUBLIC_BASE_URL ?? `${proto}://${host}`;
    const post = await fetch(`${base}/api/reviews/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    // ignore POST errors here; try reading again
    if (post.ok) res = await getReview(id);
  }

  const turns: { role: "user" | "assistant"; text: string; url?: string | null; audioUrl?: string | null }[] = Array.isArray(res.data?.turns)
    ? res.data!.turns.map((t: any) => ({ 
        role: t.role, 
        text: (t.text ?? "") as string, 
        url: t.url || t.audioUrl ? ((t.url || t.audioUrl).startsWith("/") ? (t.url || t.audioUrl) : `/${t.url || t.audioUrl}`) : null,
        audioUrl: t.audioUrl || t.url ? ((t.audioUrl || t.url).startsWith("/") ? (t.audioUrl || t.url) : `/${t.audioUrl || t.url}`) : null
      }))
    : [];

  return (
    <main className="mx-auto max-w-3xl text-slate-100 p-6 space-y-6">
      {/* Top bar */}
      <div className="flex items-center justify-between">
        <Link href="/" className="underline text-slate-300">
          Back to Dashboard
        </Link>

        <div className="flex items-center gap-3">
          {/* Seed link: adds ?seed=1 to force-create a review if missing */}
          <Link
            href={`/review?id=${encodeURIComponent(id)}&seed=1`}
            className="inline-flex items-center gap-2 rounded-md bg-slate-800 px-3 py-1.5 text-sm hover:bg-slate-700"
          >
            Seed Test Audio
          </Link>
        </div>
      </div>

      {/* Status helper */}
      {!res.ok && (
        <div className="rounded-md border border-red-700/30 bg-red-900/20 px-3 py-2 text-sm">
          <span className="font-mono text-xs">status: {res.status}</span>{" "}
          <span className="text-red-300">Review fetch failed. Try seeding below.</span>
        </div>
      )}

  {/* Controls row */} 
  <ReviewPlayer turns={turns} />

      {/* Transcript */}
      <h2 className="uppercase tracking-wide text-slate-400 text-xs">Transcript</h2>
      <Transcript turns={turns} />

      {/* Audio Debug */}
      <h2 className="uppercase tracking-wide text-slate-400 text-xs mt-6">
        Audio Debug
      </h2>
      <div className="rounded-md bg-slate-900 text-[12px] leading-5 max-w-xl shadow">
        <div className="px-3 py-2">
          {turns.length ? (
            <div className="space-y-1">
              {turns.map((t, i) => (
                <div key={i}>
                  <span className="text-slate-300">{i}. {t.role}</span>{" "}
                  <span className={t.url ? "text-emerald-300" : "text-red-300"}>
                    {t.url ?? "(missing url)"}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-slate-500">— no turns —</div>
          )}
        </div>
      </div>

      {/* Raw dump (handy while we iterate) */}
      <h2 className="uppercase tracking-wide text-slate-400 text-xs mt-6">Raw JSON</h2>
      <pre className="max-w-xl overflow-auto text-[12px] bg-slate-900 rounded px-3 py-2 shadow">
        {JSON.stringify(
          turns.map((t) => ({ role: t.role, url: t.url ?? "", text: t.text ?? "" })),
          null,
          2
        )}
      </pre>
    </main>
  );
}