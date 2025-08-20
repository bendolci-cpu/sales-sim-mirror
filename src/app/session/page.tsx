"use client";

import { Suspense, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import ChatWindow from "@/components/ChatWindow";
import { scenarios } from "@/data/scenarios";

function SessionInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const modeRaw = (searchParams.get("mode") || "practice").toLowerCase();
  const modeLabel = modeRaw === "challenge" ? "Challenge" : "Practice";

  const initialIsMock = useMemo(() => {
    const raw = (searchParams.get("mock") || "1").toLowerCase();
    return ["1", "true", "on", "yes", "y"].includes(raw);
  }, [searchParams]);

  const [isMock, setIsMock] = useState<boolean>(initialIsMock);

  const scenarioId = searchParams.get("scenario") || "";
  const currentScenario = scenarios.find(s => s.id === scenarioId) || null;

  return (
    <main className="min-h-screen bg-gray-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Session: {modeLabel} Mode</h1>
            <p className="text-xs text-gray-500">
              Mode: {modeLabel} • Mock: {isMock ? "On" : "Off"}
              {modeLabel === "Challenge" && currentScenario ? ` • Scenario: ${currentScenario.title}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className={`text-xs ${isMock ? "text-gray-900" : "text-gray-500"}`}>Mock</span>
            <button
              type="button"
              onClick={() => {
                const nextIsMock = !isMock;
                setIsMock(nextIsMock);
                const params = new URLSearchParams(searchParams.toString());
                params.set("mock", nextIsMock ? "1" : "0");
                router.replace(`${pathname}?${params.toString()}`, { scroll: false });
              }}
              className={`relative h-6 w-11 rounded-full transition ${isMock ? "bg-blue-600" : "bg-gray-300"}`}
              aria-pressed={isMock}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 transform rounded-full bg-white shadow transition ${
                  isMock ? "left-0.5 translate-x-0" : "left-0.5 translate-x-5"
                }`}
              />
            </button>
            <span className={`text-xs ${!isMock ? "text-gray-900" : "text-gray-500"}`}>Live</span>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-6 py-8 space-y-6">
        {modeLabel === "Challenge" && (
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
              <div>
                <label className="block text-xs font-medium text-gray-600">Select Scenario</label>
                <select
                  className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 md:w-[420px]"
                  value={scenarioId}
                  onChange={e => {
                    const params = new URLSearchParams(searchParams.toString());
                    if (e.target.value) params.set("scenario", e.target.value);
                    else params.delete("scenario");
                    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
                  }}
                >
                  <option value="">-- Pick a scenario --</option>
                  {scenarios.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.title} • {s.role} • {s.industry}
                    </option>
                  ))}
                </select>
              </div>
              {currentScenario && (
                <div className="text-xs text-gray-600 md:text-right">
                  <div className="font-medium text-gray-900">{currentScenario.title}</div>
                  <div>
                    {currentScenario.role} • {currentScenario.industry}
                  </div>
                </div>
              )}
            </div>
            {currentScenario && (
              <p className="mt-3 text-sm text-gray-700">{currentScenario.description}</p>
            )}
          </div>
        )}

        <ChatWindow isMock={isMock} starterMessage={currentScenario?.starter} />
      </section>
    </main>
  );
}

export default function SessionPage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-gray-50" />}> 
      <SessionInner />
    </Suspense>
  );
}


