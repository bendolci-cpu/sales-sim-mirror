"use client";

import { Suspense, useMemo, useRef, useState, useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import ClientOnly from "@/components/ClientOnly";
const ChatWindowClient = dynamic(() => import("@/components/ChatWindow"), { ssr: false });
import BudgetBadge from "@/components/BudgetBadge";
import ScenarioPicker from "@/components/ScenarioPicker";
import { SCENARIOS, type Scenario } from "@/data/scenarios";
import { CallMachine } from "@/lib/voice/callMachine";
import { getAgentReply, speak as agentSpeak, stopSpeaking } from "@/lib/voice/mockAgent";
import CallBar from "@/components/CallBar";
import DebugToggle from "@/components/DebugToggle";
import { createWebSpeech, type WebSpeechControls } from "@/lib/speech/webSpeech";
import { saveCall } from "@/lib/calls/store";
import type { CallMeta, CallTurn } from "@/lib/calls/types";
import { mic, useMicStatus } from "@/lib/mic";

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
  const [voiceConnected, setVoiceConnected] = useState<boolean>(false);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const machineRef = useRef<CallMachine | null>(null);
  const historyRef = useRef<Array<{ role: "user" | "agent"; text: string; at: number; wpm?: number; interrupted?: boolean }>>([]);
  const callIdRef = useRef<string>("");
  const startedAtRef = useRef<number>(0);
  const connectedAtRef = useRef<number>(0);
  const [showChat, setShowChat] = useState<boolean>(false);
  const greetedRef = useRef<boolean>(false);
  const lastHashRef = useRef<string>("");
  const speechRef = useRef<WebSpeechControls | null>(null);
  const [externalTurn, setExternalTurn] = useState<{ role: "user" | "bot"; text: string; timestamp?: number } | null>(null);
  const agentSpeakingRef = useRef<boolean>(false);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const micStatus = useMicStatus();

  // hydrate showChat from localStorage to avoid flicker
  useEffect(() => {
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem("showChatDebug") : null;
      if (raw === "1") setShowChat(true);
    } catch {}
  }, []);

  // helper to push turns with adjacent de-dupe and reflect into ChatWindow + history
  function pushTurn(role: "user" | "agent", text: string, extra?: { wpm?: number; interrupted?: boolean }) {
    const trimmed = (text || "").trim();
    if (!trimmed) return;
    const hash = `${role}|${trimmed}`;
    if (hash === lastHashRef.current) return;
    const last = historyRef.current[historyRef.current.length - 1];
    const lastHash = last ? `${last.role}|${(last.text || "").trim()}` : "";
    if (hash === lastHash) return;
    const at = Math.max(0, Date.now() - (connectedAtRef.current || Date.now()));
    historyRef.current.push({ role, text: trimmed, at, wpm: extra?.wpm, interrupted: extra?.interrupted });
    lastHashRef.current = hash;
    setExternalTurn({ role: role === "user" ? "user" : "bot", text: trimmed, timestamp: Date.now() });
  }

  async function handleCall() {
    if (!isMock) return; // mock-only
    if (!machineRef.current) machineRef.current = new CallMachine();
    const m = machineRef.current;
    m.start();
    setVoiceConnected(false);
    setTimeout(() => { m.answer(); setVoiceConnected(true); connectedAtRef.current = Date.now(); }, 1200);
    startedAtRef.current = Date.now();
    callIdRef.current = crypto.randomUUID();
    // Start Mic singleton and begin recording
    try {
      const stream = await mic.start();
      if (stream) setMicStream(stream);
      mic.startRecording();
      setIsRecording(true);
    } catch (err) { console.error('Mic start failed', err); }
    // Agent greeting once connected (single guard)
    const unsub = m.subscribe((state) => {
      if (state === "connected") {
        unsub();
        if (!greetedRef.current) {
          greetedRef.current = true;
          const greeting = currentScenario ? `Hi, this is ${currentScenario.persona}. ${currentScenario.brief.split(".")[0]}.` : "Hi, thanks for calling.";
          pushTurn("agent", greeting);
          agentSpeakingRef.current = true;
          setTimeout(() => agentSpeak(greeting).then(() => { agentSpeakingRef.current = false; }), 300);
        }
        // start continuous web speech
        if (!speechRef.current) {
          speechRef.current = createWebSpeech({
            onFinal: (finalText) => {
              const words = finalText.split(/\s+/).filter(Boolean).length;
              const wpm = Math.round((words / 2) * 60); // rough fallback with 2s assumed
              pushTurn("user", finalText, { wpm });
              if (agentSpeakingRef.current) {
                stopSpeaking();
              }
              if (currentScenario) {
                const reply = getAgentReply(historyRef.current, currentScenario);
                setTimeout(async () => {
                  pushTurn("agent", reply);
                  agentSpeakingRef.current = true;
                  await agentSpeak(reply);
                  agentSpeakingRef.current = false;
                }, 600 + Math.floor(Math.random() * 400));
              }
            },
          });
        }
        try { speechRef.current?.start(); } catch {}
      }
    });
  }

  async function handleEnd() {
    stopSpeaking();
    const m = machineRef.current;
    m?.end();
    setVoiceConnected(false);
    greetedRef.current = false;
    try { speechRef.current?.stop(); } catch {}
    try {
      if (isRecording) {
        const blob = await mic.stopRecording();
        setIsRecording(false);
        if (blob) setAudioUrl(URL.createObjectURL(blob));
      }
    } catch {}
    mic.stop();
    // persist record to calls store
    const endedAt = Date.now();
    const durationMs = endedAt - (startedAtRef.current || endedAt);
    const userTurns = historyRef.current.filter(t => t.role === "user");
    const agentTurns = historyRef.current.filter(t => t.role === "agent");
    const userWpmAvg = userTurns.length ? Math.round(userTurns.reduce((s, t) => s + (t.wpm || 0), 0) / userTurns.length) : undefined;
    const interruptions = historyRef.current.filter(t => t.interrupted).length;
    const turns: CallTurn[] = historyRef.current.map(t => ({ id: crypto.randomUUID(), at: t.at, speaker: t.role, text: t.text, charCount: t.text.length, wpm: t.wpm, interrupted: t.interrupted }));
    const meta: CallMeta = { id: callIdRef.current, scenarioId: currentScenario?.id || "", startedAt: startedAtRef.current, endedAt, durationMs, turns, stats: { userWpmAvg, interruptions, agentTurns: agentTurns.length, userTurns: userTurns.length } };
    try { saveCall(meta); } catch {}
    router.push("/");
  }

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
            <DebugToggle onChange={setShowChat} />
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-6 py-8 space-y-6">
        <CallBar state={voiceConnected ? "connected" : "idle"} onCall={handleCall} onEnd={handleEnd} stream={micStream} />
        <div className="-mt-4 flex justify-end px-1 text-[11px] text-gray-500">Mic: {micStatus}</div>
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
          <div className="flex flex-col items-start gap-4">
            <ClientOnly>
              <ChatWindowClient
                isMock={isMock}
                voiceConnected={voiceConnected}
                callActive={voiceConnected}
                seedMessages={isMock ? currentScenario?.starterMessages : undefined}
                visible={showChat}
                externalTurn={externalTurn}
              />
            </ClientOnly>
          </div>
        ) : (
          <div className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-600">Pick a scenario on the home page to start a session.</div>
        )}
        {audioUrl && (
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="text-xs font-medium text-gray-700">Call Audio (local)</div>
            <audio controls src={audioUrl} className="mt-2 w-full" />
          </div>
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


