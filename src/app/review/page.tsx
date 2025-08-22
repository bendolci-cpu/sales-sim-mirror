"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { loadCall } from "@/lib/calls/store";
import type { CallMeta } from "@/lib/calls/types";

export default function ReviewPage() {
  const search = useSearchParams();
  const router = useRouter();
  const id = search.get("id") || "";
  const [record, setRecord] = useState<CallMeta | null>(null);

  useEffect(() => {
    try { setRecord(loadCall(id)); } catch { setRecord(null); }
  }, [id]);

  const meta = useMemo(() => {
    if (!record) return { duration: "00:00", turns: 0 };
    const mm = String(Math.floor(record.durationMs / 1000 / 60)).padStart(2, "0");
    const ss = String(Math.floor(record.durationMs / 1000) % 60).padStart(2, "0");
    return { duration: `${mm}:${ss}`, turns: record.turns.length };
  }, [record]);

  function speak(text: string) {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "en-US"; window.speechSynthesis.speak(utter);
  }

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
        {record?.stats && (
          <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="rounded-lg border bg-white p-3">
              <div className="text-xs text-gray-500">Pacing</div>
              <div className="text-sm font-medium text-gray-900">{record.stats.userWpmAvg ?? "–"} wpm</div>
              <div className="text-[11px] text-gray-500">
                {(record.stats.userWpmAvg ?? 0) < 100 ? "Slow" : (record.stats.userWpmAvg ?? 0) > 150 ? "Fast" : "OK"}
              </div>
            </div>
            <div className="rounded-lg border bg-white p-3">
              <div className="text-xs text-gray-500">Interruptions</div>
              <div className="text-sm font-medium text-gray-900">{record.stats.interruptions ?? 0}</div>
              <div className="text-[11px] text-gray-500">{(record.stats.interruptions ?? 0) === 0 ? "None" : (record.stats.interruptions ?? 0) === 1 ? "Some" : "Many"}</div>
            </div>
            <div className="rounded-lg border bg-white p-3">
              <div className="text-xs text-gray-500">Participation</div>
              <div className="text-sm font-medium text-gray-900">User {record.stats.userTurns ?? 0} • Agent {record.stats.agentTurns ?? 0}</div>
            </div>
          </div>
        )}
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
            const a = `${prev.speaker}|${(prev.text || "").trim()}`;
            const b = `${t.speaker}|${(t.text || "").trim()}`;
            return a !== b;
          }).map((turn, idx) => (
            <div key={idx} className={`flex ${turn.speaker === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`inline-flex max-w-[80%] items-center gap-2 rounded-2xl px-3 py-2 text-sm ${turn.speaker === "user" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-900"}`}>
                <span>{turn.text}</span>
                {turn.speaker === "agent" && (
                  <button className="rounded-md border border-gray-300 bg-white px-2 py-1 text-[10px] text-gray-700 hover:bg-gray-50" onClick={() => speak(turn.text)}>Play</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}


