// server component
export const dynamic = "force-dynamic";

import Link from "next/link";
import PlayCallButton, { type Turn } from "@/components/PlayCallButton";

async function getReview(id: string) {
  try {
    // Try absolute first (works if NEXT_PUBLIC_BASE_URL set)
    const abs = process.env.NEXT_PUBLIC_BASE_URL
      ? `${process.env.NEXT_PUBLIC_BASE_URL}/api/reviews/${id}`
      : null;

    const r = abs
      ? await fetch(abs, { cache: "no-store" })
      : await fetch(`/api/reviews/${id}`, { cache: "no-store" });

    if (!r.ok) {
      // Try relative if absolute failed
      const rr = await fetch(`/api/reviews/${id}`, { cache: "no-store" });
      if (!rr.ok) return { ok: false, status: rr.status, data: null };
      return { ok: true, status: 200, data: await rr.json() };
    }
    return { ok: true, status: 200, data: await r.json() };
  } catch (e: any) {
    return { ok: false, status: 500, data: null, err: String(e) };
  }
}

function Transcripts({ turns }: { turns: Turn[] }) {
  return (
    <div className="space-y-3 mt-6">
      {turns.length === 0 && (
        <div className="text-sm opacity-60">No turns saved for this review.</div>
      )}
      {turns.map((t, i) => (
        <div
          key={i}
          className={`max-w-2xl rounded-lg p-3 shadow ${
            t.role === "user" ? "bg-white text-slate-900" : "bg-indigo-50 text-slate-900"
          }`}
        >
          <div className="text-[10px] uppercase tracking-wide opacity-60">{t.role}</div>
          <div className="text-sm whitespace-pre-wrap">
            {t.text || <span className="opacity-50">— no text —</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

export default async function ReviewPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }
) {
  const params = await searchParams;

  // helper: normalize string | string[] | undefined -> string
  const get = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;

  const id = get(params?.id) ?? "";
  const seed = get(params?.seed) ?? "";
  if (!id) {
    return (
      <main className="min-h-screen bg-slate-950 text-slate-100 p-8">
        <div className="mb-4">
          <Link href="/" className="underline text-slate-300">
            Back to Dashboard
          </Link>
        </div>
        <div className="text-red-300">Missing review id.</div>
      </main>
    );
  }

  const res = await getReview(id);
  const rawTurns: Turn[] = Array.isArray(res?.data?.turns) ? res.data.turns : [];

  // Dev helper: seed tone URLs when ?seed=1
  const turns: Turn[] =
    searchParams?.seed === "1"
      ? rawTurns.map((t) => ({ ...t, audioUrl: t.audioUrl ?? "/api/audio/test-ai" }))
      : rawTurns;

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-8">
      <div className="flex items-center gap-3">
        <PlayCallButton turns={turns} />
        <Link
          href={`/review?id=${encodeURIComponent(id)}&seed=1`}
          className="px-3 py-2 rounded bg-slate-200 text-slate-900"
        >
          Seed Test Audio
        </Link>
        <Link href="/" className="ml-auto underline text-slate-300">
          Back to Dashboard
        </Link>
      </div>

      {/* Health/status banner */}
      <div className="mt-4 text-xs font-mono bg-white text-slate-900 rounded p-3 max-w-3xl shadow">
        <div>status: {res.ok ? "ok" : "error"} ({res.status ?? "?"})</div>
        {!res.ok && <div className="text-red-600">Review fetch failed. Try seeding below.</div>}
      </div>

      <Transcripts turns={turns} />

      {/* Audio Debug */}
      <div className="mt-6 max-w-3xl rounded p-3 text-xs font-mono bg-white text-slate-900 shadow">
        {turns.length === 0 ? (
          <div>— no turns —</div>
        ) : (
          turns.map((t, i) => (
            <div key={i}>
              #{i} {t.role.padEnd(8, " ")} — {t.audioUrl ?? "—"}
            </div>
          ))
        )}
      </div>

      {/* Raw dump */}
      <pre className="mt-4 max-w-3xl overflow-auto text-[11px] bg-slate-900 text-slate-100 rounded p-3 shadow">
{JSON.stringify(
  turns.map((t) => ({ role: t.role, url: t.audioUrl ?? "", text: (t.text || "").slice(0, 80) })),
  null,
  2
)}
      </pre>
    </main>
  );
} 