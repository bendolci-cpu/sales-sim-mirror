"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import ScenarioPicker from "@/components/ScenarioPicker";

export default function Home() {
  const router = useRouter();
  const [scenarioId, setScenarioId] = useState<string>("");

  return (
    <main className="min-h-screen bg-gray-50">  
      <section className="mx-auto flex max-w-5xl flex-col items-center px-6 py-16"> 
        <h1 className="text-3xl font-semibold text-gray-900">Sales Sim</h1>
        <p className="mt-2 text-sm text-gray-600">Choose a mode to get started</p>

        <div className="mt-6 w-full max-w-3xl">
          <ScenarioPicker size="lg" value={scenarioId} onChange={setScenarioId} />
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
                onClick={() => router.push(`/session?mode=challenge&mock=1&scenario=${encodeURIComponent(scenarioId)}`)}
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
                onClick={() => router.push(`/session?mode=practice&mock=1&scenario=${encodeURIComponent(scenarioId)}`)}
                className="inline-flex items-center rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Start Practice
              </button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}