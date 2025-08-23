"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import MetricCard from "@/components/MetricCard";
import PlayCallButton from "@/components/PlayCallButton";
// Client component: do NOT export revalidate here

export default function ReviewPage() {
  const search = useSearchParams();
  const router = useRouter();
  const id = search.get("id") || "";
  type AgentTurn = { role: "user" | "agent"; text: string; ts: number; audioUrl?: string };
  type CallReview = {
    id: string;
    scenarioId: string | null;
    startedAt: number;
    endedAt: number;
    durationSec: number;
    turns: AgentTurn[];
    audioUrl?: string;
    wpm?: number;
    interruptions?: number;
    metrics?: {
      clarityScore?: number;
      pacingWpm?: number;
      tonalityScore?: number;
    };
  };
  const [record, setRecord] = useState<CallReview | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!id) return;
      try {
        const res = await fetch(`/api/reviews/${id}`, { cache: "no-store" });
        if (!res.ok) { setRecord(null); return; }
        const j = await res.json();
        if (!cancelled) setRecord(j as CallReview);
      } catch { if (!cancelled) setRecord(null); }
    }
    load();
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    if (!record) return;
    try { console.table(record.turns); } catch {}
  }, [record]);

  const meta = useMemo(() => {
    if (!record) return { duration: "00:00", turns: 0 };
    const mm = String(Math.floor(record.durationSec / 60)).padStart(2, "0");
    const ss = String(record.durationSec % 60).padStart(2, "0");
    return { duration: `${mm}:${ss}`, turns: record.turns.length };
  }, [record]);

  const computedMetrics = useMemo(() => {
    if (!record) return { clarityScore: undefined, pacingWpm: undefined, tonalityScore: undefined } as const;
    const existing = record.metrics || {};
    // pacingWpm: words spoken by user / total user speaking seconds
    let pacingWpm = existing.pacingWpm;
    if (pacingWpm == null) {
      const userWords = record.turns.filter(t => t.role === "user").map(t => (t.text || "").trim()).join(" ").split(/\s+/).filter(Boolean).length;
      const userSeconds = Math.max(1, Math.round(record.durationSec * 0.6)); // heuristic: assume 60% of time user spoke if unknown
      pacingWpm = Math.round((userWords / userSeconds) * 60);
    }
    // clarityScore: start 100, subtract for filler words and long sentences
    let clarityScore = existing.clarityScore;
    if (clarityScore == null) {
      const text = record.turns.filter(t => t.role === "user").map(t => t.text).join(" ");
      const fillers = (text.match(/\b(um|uh|like|you know)\b/gi) || []).length;
      const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);
      const longSentences = sentences.filter(s => s.split(/\s+/).filter(Boolean).length > 22).length;
      let score = 100 - fillers * 2 - longSentences * 5;
      clarityScore = Math.max(0, Math.min(100, score));
    }
    // tonalityScore: simple variance proxy using punctuation/phrase length variance
    let tonalityScore = existing.tonalityScore;
    if (tonalityScore == null) {
      const phrases = record.turns.map(t => (t.text || "").split(/,|;|\-|\.|!|\?/).map(p => p.trim()).filter(Boolean)).flat();
      if (phrases.length <= 1) {
        tonalityScore = 50;
      } else {
        const lengths = phrases.map(p => p.split(/\s+/).filter(Boolean).length);
        const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
        const variance = lengths.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / lengths.length;
        // Map variance to 0-100 where moderate variance ~ good
        const normalized = Math.max(0, Math.min(100, 70 + (variance - 5) * 5));
        tonalityScore = Math.round(normalized);
      }
    }
    return { clarityScore, pacingWpm, tonalityScore } as const;
  }, [record]);


  // removed per-bubble TTS play for assistant; keeping no-op helper unused

  if (!record) return <main className="mx-auto max-w-3xl p-6"><div className="rounded-lg border bg-white p-6 text-sm text-gray-700">No record found.<br/><button className="mt-4 rounded-md border px-3 py-1.5 text-xs" onClick={() => router.push("/")}>Back to Dashboard</button></div></main>;

  return (
    <main className="min-h-screen bg-gray-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Call Review</h1>
            <p className="text-xs text-gray-500">Duration: {meta.duration} • Turns: {meta.turns}</p>
          </div>
          <button className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50" onClick={() => router.push("/")}>Back to Dashboard</button>
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-6 py-8">
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <MetricCard label="Clarity" value={computedMetrics.clarityScore ?? "—"} sublabel="word choice & filler words" />
          <MetricCard label="Pacing" value={`${computedMetrics.pacingWpm ?? "—"} wpm`} sublabel="target: 130–160 wpm" />
          <MetricCard label="Tonality" value={computedMetrics.tonalityScore ?? "—"} sublabel="pitch & energy variation" />
        </div>
        <div className="mb-6">
          <PlayCallButton turns={record.turns} />
        </div>
        <div className="mb-6">
          <button
            onClick={() => {
              setRecord(prev => {
                if (!prev) return prev;
                const turns = [...prev.turns];
                // seed first user and first agent
                const uIdx = turns.findIndex(t => t.role === "user");
                if (uIdx >= 0) turns[uIdx] = { ...turns[uIdx], audioUrl: "/api/audio/test-user" } as any;
                const aIdx = turns.findIndex(t => t.role === "agent");
                if (aIdx >= 0) turns[aIdx] = { ...turns[aIdx], audioUrl: "/api/audio/test-ai" } as any;
                const next = { ...prev, turns } as typeof prev;
                return next;
              });
            }}
            className="rounded-lg border px-3 py-2 text-sm shadow-sm hover:bg-gray-50"
          >
            Seed Test Audio
          </button>
        </div>
        {/* Dev-only Audio Debug panel */}
        <AudioDebug turns={record.turns} />
        <div className="mb-6 rounded-lg border bg-white p-4">
          <div className="text-sm font-medium text-gray-900">Feedback</div>
          <div className="mt-1 text-[13px] text-gray-700">
            <div><span className="font-medium">What you did well:</span> Clear turn-taking and engagement.</div>
            <div><span className="font-medium">What to improve:</span> Ask more discovery questions and pace under 150 wpm.</div>
          </div>
        </div>
        <div className="space-y-3">
          {record.turns.filter((t, i, arr) => {
            const prev = arr[i - 1];
            if (!prev) return true;
            const a = `${prev.role}|${(prev.text || "").trim()}`;
            const b = `${t.role}|${(t.text || "").trim()}`;
            return a !== b;
          }).map((turn, idx) => (
            <div key={idx} className={`flex ${turn.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`inline-flex max-w-[80%] items-center gap-2 rounded-2xl px-3 py-2 text-sm ${turn.role === "user" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-900"}`}>
                <span>{turn.text}</span>
                {/* per-bubble play removed for assistant; could add for user if needed */}
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}


function AudioDebug({ turns }: { turns: { role: string; audioUrl?: string }[] }) {
  const [rows, setRows] = useState<Array<{ idx: number; role: string; url: string; status: number | null; contentType: string | null; contentLength: string | null; method: string; ok: boolean; error?: string }>>([]);

  useEffect(() => {
    let cancelled = false;
    async function probe() {
      const out: Array<{ idx: number; role: string; url: string; status: number | null; contentType: string | null; contentLength: string | null; method: string; ok: boolean; error?: string }> = [];
      const urls = (turns || []).map((t, i) => ({ idx: i, role: t.role, url: t.audioUrl || "" }));
      for (const { idx, role, url } of urls) {
        if (!url) {
          out.push({ idx, role, url, status: null, contentType: null, contentLength: null, method: "NONE", ok: false, error: "missing url" });
          continue;
        }
        // Try HEAD first
        try {
          let res = await fetch(url, { method: "HEAD", credentials: "include", cache: "no-store" });
          let methodUsed = "HEAD";
          if (!res.ok || !res.headers) {
            // Fallback to GET (headers only), cancel body asap
            res = await fetch(url, { method: "GET", credentials: "include", cache: "no-store" });
            methodUsed = "GET";
            try { (res as any).body?.cancel?.(); } catch {}
          }
          const status = res.status;
          const ct = res.headers.get("content-type");
          const cl = res.headers.get("content-length");
          const ok = status === 200 && (ct?.startsWith("audio/") ?? false);
          console.log("[AudioDebug]", { idx, url, status, contentType: ct, contentLength: cl, method: methodUsed });
          out.push({ idx, role, url, status, contentType: ct, contentLength: cl, method: methodUsed, ok });
        } catch (e: any) {
          console.warn("[AudioDebug] fetch error", url, e);
          out.push({ idx, role, url, status: null, contentType: null, contentLength: null, method: "ERR", ok: false, error: String(e) });
        }
      }
      if (!cancelled) setRows(out);
    }
    probe();
    return () => { cancelled = true; };
  }, [turns]);

  if (!rows.length) return null;
  return (
    <div className="mb-6 rounded-lg border bg-white p-4">
      <div className="mb-2 text-sm font-medium text-gray-900">Audio Debug</div>
      <div className="mb-2 text-xs text-gray-700">
        URLs sample: {turns.slice(0,2).map(t => (t.audioUrl ? t.audioUrl.slice(0,60) : '(none)')).join(" | ")}
      </div>
      <div className="space-y-1">
        {rows.map(r => {
          const color = !r.url ? "text-red-600" : r.ok ? "text-green-600" : r.status === 200 ? "text-yellow-600" : "text-red-600";
          return (
            <div key={r.idx} className={`text-xs ${color}`}>
              <span className="font-mono mr-2">#{r.idx}</span>
              <span className="mr-2">{r.role}</span>
              <span className="mr-2 truncate">{r.url || "(no url)"}</span>
              <span className="mr-2">{r.method}</span>
              <span className="mr-2">{r.status ?? "–"}</span>
              <span className="mr-2">{r.contentType ?? "(ct: –)"}</span>
              <span className="mr-2">{r.contentLength ?? "(len: –)"}</span>
              {r.error ? <span className="mr-2">{r.error}</span> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

