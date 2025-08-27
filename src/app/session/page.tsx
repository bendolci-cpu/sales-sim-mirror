"use client";


import { Room, createLocalAudioTrack } from "livekit-client";
import { useRef, useState, useMemo, useEffect, Suspense } from "react";
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

function ensureAudioEl(id: string): HTMLAudioElement {
  let el = document.getElementById(id) as HTMLAudioElement | null;
  if (!el) {
    el = document.createElement("audio");
    el.id = id;
    el.style.display = "none";
    document.body.appendChild(el);
  }
  return el;
}

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
  // Scenario selection (must be defined before use in greeting logic)
  const scenarioId: string = searchParams.get("scenario") || "";
  const currentScenario: Scenario | null = useMemo(() => {
    const found = SCENARIOS.find((s: Scenario) => s.id === scenarioId);
    return found ?? null;
  }, [scenarioId]);
  // LIVEKIT
const roomRef = useRef<Room | null>(null);
  const historyRef = useRef<Array<{ role: "user" | "agent"; text: string; at: number; wpm?: number; interrupted?: boolean; audioUrl?: string }>>([]);
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
  const pendingUserAudioRef = useRef<string | null>(null);
  // Per-turn recording refs
  const localMicTrackRef = useRef<MediaStreamTrack | null>(null);
  const agentTrackRef = useRef<MediaStreamTrack | null>(null);
  const userRecRef = useRef<MediaRecorder | null>(null);
  const agentRecRef = useRef<MediaRecorder | null>(null);
  const userRecDoneRef = useRef<Promise<string | null> | null>(null);
  const agentRecDoneRef = useRef<Promise<string | null> | null>(null);

  // hydrate showChat from localStorage to avoid flicker
  useEffect(() => {
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem("showChatDebug") : null;
      if (raw === "1") setShowChat(true);
    } catch {}
  }, []);

  // helper to push turns with adjacent de-dupe and reflect into ChatWindow + history
  function pushTurn(role: "user" | "agent", text: string, extra?: { wpm?: number; interrupted?: boolean; audioUrl?: string }) {
    const trimmed = (text || "").trim();
    if (!trimmed) return;
    const hash = `${role}|${trimmed}`;
    if (hash === lastHashRef.current) return;
    const last = historyRef.current[historyRef.current.length - 1];
    const lastHash = last ? `${last.role}|${(last.text || "").trim()}` : "";
    if (hash === lastHash) return;
    const at = Math.max(0, Date.now() - (connectedAtRef.current || Date.now()));
    historyRef.current.push({ role, text: trimmed, at, wpm: extra?.wpm, interrupted: extra?.interrupted, audioUrl: extra?.audioUrl });
    lastHashRef.current = hash;
    setExternalTurn({ role: role === "user" ? "user" : "bot", text: trimmed, timestamp: Date.now() });
  }

  async function uploadBlobGetUrl(blob: Blob): Promise<string | null> {
    try {
      const fd = new FormData();
      fd.append("file", new File([blob], "clip.webm", { type: blob.type || "audio/webm" }));
      const res = await fetch("/api/upload-audio", { method: "POST", body: fd });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.audioUrl || null;
    } catch { return null; }
  }

  function synthBeepWav(seconds = 1, freq = 560): Blob {
    const sampleRate = 44100;
    const length = sampleRate * seconds;
    const buffer = new ArrayBuffer(44 + length * 2);
    const view = new DataView(buffer);
    function w(off: number, s: string) { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); }
    w(0,'RIFF'); view.setUint32(4, 36 + length * 2, true); w(8,'WAVE'); w(12,'fmt ');
    view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true); view.setUint32(24,sampleRate,true);
    view.setUint32(28,sampleRate*2,true); view.setUint16(32,2,true); view.setUint16(34,16,true); w(36,'data'); view.setUint32(40,length*2,true);
    let off = 44;
    for (let i=0;i<length;i++){ const t=i/sampleRate; const s=Math.sin(2*Math.PI*freq*t)*0.25; view.setInt16(off, Math.floor(s*32767), true); off+=2; }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  // Start a MediaRecorder on a single track and resolve to an object URL on stop
  function startRecorderForTrack(track: MediaStreamTrack): { rec: MediaRecorder; done: Promise<string | null> } {
    const stream = new MediaStream([track]);
    const rec = new MediaRecorder(stream);
    const chunks: BlobPart[] = [];
    let resolveDone: (url: string | null) => void = () => {};
    const done = new Promise<string | null>((resolve) => { resolveDone = resolve; });
    rec.ondataavailable = (e: BlobEvent) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      try {
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        const url = URL.createObjectURL(blob);
        resolveDone(url);
      } catch {
        resolveDone(null);
      }
    };
    try { rec.start(); } catch {}
    return { rec, done };
  }


// LIVEKIT: connect & publish mic
async function startLiveKitCall(identity = "user", roomName = "sales-sim") {
  const res = await fetch(`/api/getToken?identity=${identity}&roomName=${roomName}`);
  const { token } = await res.json();
  if (!token) throw new Error("No LiveKit token returned");

  const url = process.env.NEXT_PUBLIC_LIVEKIT_URL || "";
  if (!url || !url.startsWith("wss://")) {
    throw new Error(`Bad LIVEKIT_URL: "${url}"`);
  }

  const room = new Room();
  await room.connect(url, token);

  const audioTrack = await createLocalAudioTrack();
  await room.localParticipant.publishTrack(audioTrack);
  // keep a reference for per-turn user recording
  localMicTrackRef.current = audioTrack.mediaStreamTrack;

  // Local mic monitor (muted)
  const micEl = ensureAudioEl("micMonitor");
  micEl.muted = true;
  micEl.autoplay = true;
  // @ts-expect-error playsInline exists on HTMLMediaElement in browsers
  micEl.playsInline = true;
  try {
    micEl.srcObject = new MediaStream([audioTrack.mediaStreamTrack]);
    micEl.play?.().catch(() => {});
  } catch {}

  // Remote audio subscription
  room.on("trackSubscribed", (track: any) => {
    try {
      if (track?.kind === "audio" || track?.kind === 2) {
        if (track?.mediaStreamTrack) agentTrackRef.current = track.mediaStreamTrack as MediaStreamTrack;
        const agentEl = ensureAudioEl("agentMonitor");
        agentEl.muted = false;
        agentEl.autoplay = true;
        // @ts-expect-error playsInline exists on HTMLMediaElement in browsers
        agentEl.playsInline = true;
        try {
          if (typeof track.attach === "function") {
            const el = track.attach();
            if (!agentEl.srcObject && (el as any).srcObject) {
              agentEl.srcObject = (el as any).srcObject as MediaStream;
            } else if (track.mediaStreamTrack) {
              agentEl.srcObject = new MediaStream([track.mediaStreamTrack]);
            }
          } else if (track.mediaStreamTrack) {
            agentEl.srcObject = new MediaStream([track.mediaStreamTrack]);
          }
          agentEl.play().catch(() => {});
        } catch {}
      }
    } catch {}
  });

  (window as any).__livekitAudio = {
    room,
    localTrack: audioTrack,
    micElId: "micMonitor",
    agentElId: "agentMonitor",
  };

  roomRef.current = room;
  setVoiceConnected(true);
  console.log("LiveKit: connected & mic published");
}

// LIVEKIT: disconnect
async function endLiveKitCall() {
  try {
    // Stop any in-progress per-turn recorders
    try { userRecRef.current?.stop(); } catch {}
    try { agentRecRef.current?.stop(); } catch {}
    userRecRef.current = null; agentRecRef.current = null;
    const refs = (window as any).__livekitAudio;
    if (refs?.localTrack) {
      try { await refs.room?.localParticipant.unpublishTrack(refs.localTrack); } catch {}
      try { refs.localTrack.stop(); } catch {}
    }
    const micEl = document.getElementById(refs?.micElId) as HTMLAudioElement | null;
    if (micEl) { try { micEl.pause(); } catch {} micEl.srcObject = null; micEl.remove(); }
    const agentEl = document.getElementById(refs?.agentElId) as HTMLAudioElement | null;
    if (agentEl) { try { agentEl.pause(); } catch {} agentEl.srcObject = null; agentEl.remove(); }
    try {
      refs?.room?.participants.forEach((p: any) => {
        p.audioTracks.forEach((pub: any) => {
          const t: any = pub?.audioTrack;
          if (t?.detach) {
            try { t.detach().forEach((el: HTMLMediaElement) => { try { el.pause?.(); } catch {}; (el as any).srcObject = null; el.remove?.(); }); } catch {}
          }
        });
      });
    } catch {}
  } catch {}
  finally {
    try { await roomRef.current?.disconnect(); } catch {}
    roomRef.current = null;
    setVoiceConnected(false);
    console.log("LiveKit: disconnected");
  }
}


  async function handleCall() {
    await startLiveKitCall("test-user", "sales-sim");
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
    const unsub = m.subscribe(async (state) => {
      if (state === "connected") {
        unsub();
        if (!greetedRef.current) {
          greetedRef.current = true;
          const greeting = currentScenario
            ? `Hi, this is ${currentScenario.persona}. ${currentScenario.brief.split(".")[0]}.`
            : "Hi, thanks for calling.";
          const r = await fetch("/api/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: greeting }),
          });
          const j = r.ok ? await r.json() : null;
          const gurl = j?.url ?? null;
          pushTurn("agent", greeting, { audioUrl: gurl || undefined });
          await new Promise((res) => setTimeout(res, 600 + Math.floor(Math.random() * 400)));
        }
        // start continuous web speech
        if (!speechRef.current) {
          speechRef.current = createWebSpeech({
            onSpeechStart: () => {
              pendingUserAudioRef.current = null;
              try { mic.startRecording(); } catch {}
              // start per-turn local recorder on the mic track
              try {
                if (localMicTrackRef.current) {
                  const { rec, done } = startRecorderForTrack(localMicTrackRef.current);
                  userRecRef.current = rec;
                  userRecDoneRef.current = done;
                }
              } catch {}
            },
            onSpeechEnd: async () => {
              try {
                const blob = await mic.stopRecording();
                if (blob && blob.size > 0) {
                  const url = await uploadBlobGetUrl(blob);
                  // store until we push on onFinal
                  pendingUserAudioRef.current = url;
                }
              } catch (e) { console.warn("upload user audio failed", e); }
            },
            onFinal: async (finalText) => {
              const words = finalText.split(/\s+/).filter(Boolean).length;
              const wpm = Math.round((words / 2) * 60); // rough fallback with 2s assumed
              // stop per-turn recorder and await object URL
              let turnUrl: string | null = pendingUserAudioRef.current || null;
              try { userRecRef.current?.stop(); } catch {}
              try { turnUrl = (await userRecDoneRef.current) ?? turnUrl; } catch {}
              userRecRef.current = null; userRecDoneRef.current = null;
              const audioUrl = turnUrl || "/api/audio/test-user";
              pushTurn("user", finalText, { wpm, audioUrl });
              console.log("[Turn:user]", { text: finalText.slice(0,40), audioUrl });
              pendingUserAudioRef.current = null;
              if (agentSpeakingRef.current) {
                stopSpeaking();
              }
              if (currentScenario) {
                const reply = getAgentReply(historyRef.current, currentScenario);
                setTimeout(async () => {
                  // Start per-turn agent recorder as soon as we have remote track
                  if (!agentRecRef.current && agentTrackRef.current) {
                    try {
                      const { rec, done } = startRecorderForTrack(agentTrackRef.current);
                      agentRecRef.current = rec;
                      agentRecDoneRef.current = done;
                    } catch {}
                  }
                  // Real TTS pipeline: call /api/tts (stub returns seeded URL)
                  let aurl: string | null = null;
                  try {
                    const r = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: reply }) });
                    if (r.ok) { const j = await r.json(); aurl = j?.url ?? null; }
                  } catch {}
                  // Stop agent recorder and prefer per-turn object URL over stub
                  // Stop agent recorder; use its blob only if TTS failed
try { agentRecRef.current?.stop(); } catch {}
try {
  const recorded = (await agentRecDoneRef.current) ?? null;
  if (!aurl && recorded) aurl = recorded; // ← only fallback when no TTS URL
} catch {}
agentRecRef.current = null;
agentRecDoneRef.current = null;
if (aurl) {
  pushTurn("agent", reply, { audioUrl: aurl });
  console.log("[Turn:assistant]", { text: reply.slice(0,40), audioUrl: aurl });
} else {
  // No TTS and no recording — skip pushing empty audio to avoid mic re-records
  console.warn("No TTS or recording available — skipping agent audio for this turn");
}

// Do NOT speak locally; that leaks into the mic recording
await new Promise((resolve) => setTimeout(resolve, 600 + Math.floor(Math.random() * 400)));
try { speechRef.current?.start(); } catch {}
            },
          });
        }
        try { speechRef.current?.start(); } catch {}
      }
    });

  async function handleEnd() {
    await endLiveKitCall();
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
    // Build minimal CallReview and persist to localStorage under "calls"
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
    };

    const id = callIdRef.current || crypto.randomUUID();
    const startedAt = startedAtRef.current || Date.now();
    const endedAt = Date.now();
    const durationSec = Math.max(0, Math.round((endedAt - startedAt) / 1000));
    const turnsForReview: AgentTurn[] = historyRef.current.map(t => ({
      role: t.role,
      text: t.text,
      ts: startedAt + t.at,
      audioUrl: (t as any).audioUrl ?? null,
    }));
    const call: CallReview = {
      id,
      scenarioId: currentScenario?.id ?? null,
      startedAt,
      endedAt,
      durationSec,
      turns: turnsForReview,
      audioUrl: audioUrl || undefined,
    };
    try {
      // Persist in localStorage (legacy) and also POST to file API
      const key = "calls";
      const list = JSON.parse(localStorage.getItem(key) || "[]") as CallReview[];
      const dedup = list.filter(c => c.id !== call.id);
      dedup.unshift(call);
      localStorage.setItem(key, JSON.stringify(dedup));
      await fetch(`/api/reviews/${id}`, { method: 'POST', body: JSON.stringify(call), headers: { 'Content-Type': 'application/json' } });
      console.log("[ReviewSaved]", call.id, call.turns.map(t => ({ role: t.role, hasUrl: !!(t as any).audioUrl })));
    } catch (e) { console.error("[EndCall] persist failed", e); }
    router.push(`/review?id=${id}`);
  }

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
              onClick={handleEnd}
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
            <button
              type="button"
              onClick={() => {
                const last3 = historyRef.current.slice(-3).map(t => ({ role: t.role, text: (t.text||'').slice(0,30), audioUrl: t.audioUrl }));
                console.log("[LastTurns]", last3);
              }}
              className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
            >
              Log last turns
            </button>
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


