"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

type Turn = { t: number; role: "user" | "agent"; text: string };
type CallRecord = { id: string; startedAt: number; durationMs: number; scenarioId: string; turns: Turn[]; audioNote?: string };

export default function ReviewPage() {
  const search = useSearchParams();
  const router = useRouter();
  const id = search.get("id") || "";
  const [record, setRecord] = useState<CallRecord | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("pp_calls");
      const list: CallRecord[] = raw ? JSON.parse(raw) : [];
      const found = list.find(r => r.id === id) || null;
      setRecord(found);
    } catch { setRecord(null); }
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
        <div className="space-y-3">
          {record.turns.map((turn, idx) => (
            <div key={idx} className={`flex ${turn.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`inline-flex max-w-[80%] items-center gap-2 rounded-2xl px-3 py-2 text-sm ${turn.role === "user" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-900"}`}>
                <span>{turn.text}</span>
                {turn.role === "agent" && (
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


