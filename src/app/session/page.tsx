"use client";

import { Suspense, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import ChatWindow from "@/components/ChatWindow";
import BudgetBadge from "@/components/BudgetBadge";
import ScenarioPicker from "@/components/ScenarioPicker";
import { SCENARIOS, type Scenario } from "@/data/scenarios";

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

  const scenarioId: string = searchParams.get("scenario") || "";
  const currentScenario: Scenario | null = useMemo(() => {
    const found = SCENARIOS.find((s: Scenario) => s.id === scenarioId);
    return found ?? null;
  }, [scenarioId]);

  return (
    <main className="min-h-screen bg-gray-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold text-gray-900">Session: {modeLabel} Mode</h1>
              <span className={`rounded-full px-2 py-0.5 text-[10px] ${isMock ? "bg-blue-50 text-blue-700" : "bg-gray-100 text-gray-700"}`}>
                Mock: {isMock ? "On" : "Off"}
              </span>
            </div>
            <p className="text-xs text-gray-500">
              {modeLabel === "Challenge" && currentScenario ? `Scenario: ${currentScenario.title}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <BudgetBadge />
            <span className={`text-xs ${isMock ? "text-gray-900" : "text-gray-500"}`}>Mock</span>
            <button
              type="button"
              onClick={async () => {
                try {
                  const resp = await fetch("/api/budget");
                  const data = await resp.json();
                  if (data && data.allowed === false) {
                    return; // Budget cap reached; keep mock ON
                  }
                } catch {}
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
            <button
              type="button"
              onClick={() => router.push("/")}
              className="ml-2 rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
            >
              End Session
            </button>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-6 py-8 space-y-6">
        {modeLabel === "Challenge" && (
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
              <div className="md:w-[480px]">
                <label className="block text-xs font-medium text-gray-600">Select Scenario</label>
                <ScenarioPicker
                  size="sm"
                  value={scenarioId}
                  onChange={(id) => {
                    const params = new URLSearchParams(searchParams.toString());
                    if (id) params.set("scenario", id);
                    else params.delete("scenario");
                    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
                  }}
                />
              </div>
              {currentScenario && (
                <div className="text-xs text-gray-600 md:text-right">
                  <div className="font-medium text-gray-900">Scenario: {currentScenario.title}</div>
                  <div className="text-gray-600">{currentScenario.setting} • {currentScenario.persona}</div>
                </div>
              )}
            </div>
            {currentScenario ? (
              <p className="mt-3 text-sm text-gray-700">{currentScenario.brief}</p>
            ) : (
              <p className="mt-3 text-sm text-gray-500">No scenario selected. Go back to the home page to pick one.</p>
            )}
            <p className="mt-2 text-[11px] text-gray-500">Mock mode seeds the chat with the scenario’s opening messages.</p>
          </div>
        )}

        {currentScenario ? (
          <ChatWindow key={`${scenarioId}-${isMock ? "mock" : "live"}`} isMock={isMock} seedMessages={isMock ? currentScenario?.starterMessages : undefined} />
        ) : (
          <div className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-600">Pick a scenario on the home page to start a session.</div>
        )}
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


