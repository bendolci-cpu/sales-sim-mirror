"use client";
import StartCallButton from "@/components/call/StartCallButton";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import ScenarioPicker from "@/components/ScenarioPicker";
import { SCENARIOS } from "@/data/scenarios";
import { addSession, getSessions, removeSession, clearSessions, type SavedSession } from "@/lib/sessions";
import BudgetBadge from "@/components/BudgetBadge";

export default function Home() {
  const router = useRouter();
  const [scenarioId, setScenarioId] = useState<string>("");
  const [sessions, setSessions] = useState<SavedSession[]>([]);

  const selected = useMemo(() => SCENARIOS.find(s => s.id === scenarioId), [scenarioId]);

  useEffect(() => {
    setSessions(getSessions());
  }, []);

  // removed debug logging

  return (
    <main className="min-h-screen bg-gray-50">  
      <section className="mx-auto flex max-w-5xl flex-col items-center px-6 py-16"> 
        <div className="flex w-full max-w-5xl items-center justify-between">
          <div>
            <h1 className="text-3xl font-semibold text-gray-900">Sales Sim</h1>
            <p className="mt-2 text-sm text-gray-600">Choose a mode to get started</p>
          </div>
          <BudgetBadge />
        </div>

        <div className="mt-6 w-full max-w-3xl">
          <ScenarioPicker size="lg" value={scenarioId} onChange={setScenarioId} />
          {selected && (
            <div className="mt-3 rounded-lg border border-gray-200 bg-white p-4">
              <div className="space-y-1">
                <div className="text-sm text-gray-500">Scenario Summary:</div>
                <div className="text-sm text-gray-900">{selected.summary}</div>
                <div className="text-sm text-gray-500">Call Point:</div>
                <div className="text-sm text-gray-900">{selected.callPoint}</div>
                <div className="text-sm text-gray-500">Topic:</div>
                <div className="text-sm text-gray-900">{selected.topic}</div>
              </div>
            </div>
          )}
          
          {/* Audio Test Link */}
          <div className="mt-4 text-center">
            <a 
              href="/test-audio" 
              className="text-sm text-blue-600 hover:text-blue-800 underline"
            >
              Test your microphone and speakers first
            </a>
          </div>
        </div>

        <div className="mt-10 grid w-full grid-cols-1 gap-6 md:grid-cols-2"> 
          <div className="group rounded-2xl border border-gray-200 bg-white p-8 shadow transition hover:shadow-md">
            <div className="flex h-full flex-col items-start">
              <div className="rounded-lg bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">Challenge</div>
              <h2 className="mt-4 text-xl font-semibold text-gray-900">Challenge Mode</h2> 
              <p className="mt-2 text-sm text-gray-600">Timed, guided scenarios with scoring.</p>      
            </div>
            <div className="mt-6">
              <button
                disabled={!scenarioId}
                onClick={() => {
                  if (!selected) return;
                  const url = `/session?mode=challenge&mock=1&scenario=${encodeURIComponent(scenarioId)}`;
                  // eslint-disable-next-line no-console
                  console.log("[Home] Start Challenge →", { url });
                  addSession({
                    id: crypto.randomUUID(),
                    ts: Date.now(),
                    mode: "challenge",
                    scenarioId,
                    scenarioTitle: selected.title,
                    callPoint: selected.callPoint,
                    topic: selected.topic,
                    url,
                  });
                  setSessions(getSessions());
                  router.push(url);
                }}
                className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Start Challenge
              </button>
            </div>
          </div>   

          <div className="group rounded-2xl border border-gray-200 bg-white p-8 shadow transition hover:shadow-md">
            <div className="flex h-full flex-col items-start">
              <div className="rounded-lg bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">Practice</div>
              <h2 className="mt-4 text-xl font-semibold text-gray-900">Practice Mode</h2>
              <p className="mt-2 text-sm text-gray-600">Free-form roleplay, no time limits.</p>
            </div>
            <div className="mt-6">
              <button
                disabled={!scenarioId}
                onClick={() => {
                  if (!selected) return;
                  const url = `/session?mode=practice&mock=1&scenario=${encodeURIComponent(scenarioId)}`;
                  // eslint-disable-next-line no-console
                  console.log("[Home] Start Practice →", { url });
                  addSession({
                    id: crypto.randomUUID(),
                    ts: Date.now(),
                    mode: "practice",
                    scenarioId,
                    scenarioTitle: selected.title,
                    callPoint: selected.callPoint,
                    topic: selected.topic,
                    url,
                  });
                  setSessions(getSessions());
                  router.push(url);
                }}
                className="inline-flex items-center rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Start Practice
              </button>
            </div>
          </div>
        </div>

        {sessions.length > 0 && (
          <section className="mt-14 w-full max-w-5xl">
            <div className="mb-3 flex items-end justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Previous Sessions</h2>
                <p className="text-xs text-gray-500">Quickly jump back into recent work.</p>
              </div>
              <button
                onClick={() => {
                  clearSessions();
                  setSessions([]);
                }}
                className="text-xs text-gray-500 hover:text-gray-700"
              >
                Clear all
              </button>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {sessions.map(sess => (
                <div key={sess.id} className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white p-4">
                  <div>
                    <div className="text-sm font-medium text-gray-900">{sess.scenarioTitle}</div>
                    <div className="text-xs text-gray-500">
                      {new Date(sess.ts).toLocaleString()} • {sess.mode.toUpperCase()} • Call Point: {sess.callPoint} • Topic: {sess.topic}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => router.push(sess.url)}
                      className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
                    >
                      Resume
                    </button>
                    <button
                      onClick={() => {
                        removeSession(sess.id);
                        setSessions(getSessions());
                      }}
                      aria-label="Remove session"
                      className="rounded-md px-2 py-1.5 text-xs text-gray-500 hover:bg-gray-100"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </section>
    </main>
  );
}