"use client";

import React from "react";
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
  const micStreamRef = useRef<MediaStream | null>(null);
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
  const voiceConnectedRef = useRef<boolean>(false);
  const [showChat, setShowChat] = useState<boolean>(false);
  const greetedRef = useRef<boolean>(false);
  const lastHashRef = useRef<string>("");
  const speechRef = useRef<WebSpeechControls | null>(null);
  const [externalTurn, setExternalTurn] = useState<{ role: "user" | "bot"; text: string; timestamp?: number } | null>(null);
  const agentSpeakingRef = useRef<boolean>(false);
  const waitingForUserRef = useRef<boolean>(false);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [isInitializing, setIsInitializing] = useState<boolean>(false);
  const [initError, setInitError] = useState<string | null>(null);
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
  const attemptedRecordingRef = useRef<boolean>(false);
  
  // Helper function to manage AI speech state
  const setAgentSpeaking = (speaking: boolean) => {
    agentSpeakingRef.current = speaking;
    if (!speaking) {
      // Resume recording when AI stops speaking
      if (userRecRef.current) {
        try {
          userRecRef.current.resume();
          console.log("[UserAudio] Resumed recording after AI speech");
        } catch (e) {
          console.warn("[UserAudio] Failed to resume recording:", e);
        }
      }
      
      // Restart mic service recording when AI stops speaking
      if (mic.isActive()) {
        try {
          mic.startRecording();
          console.log("[Mic] Restarted mic service recording after AI speech");
        } catch (e) {
          console.warn("[Mic] Failed to restart mic service recording:", e);
        }
      }
      
      // Re-enable microphone when AI stops speaking with a delay to prevent feedback
      setTimeout(() => {
        if (micStreamRef.current) {
          try {
            const audioTracks = micStreamRef.current.getAudioTracks();
            audioTracks.forEach(track => {
              track.enabled = true;
            });
            console.log("[Mic] Re-enabled microphone tracks after AI speech");
          } catch (e) {
            console.warn("[Mic] Failed to re-enable microphone tracks:", e);
          }
        }
      }, 1000); // 1 second delay to prevent feedback
    }
  };
  // Subscription and turn sequence management
  const unsubRef = useRef<(() => void) | null>(null);
  const turnSeqRef = useRef<number>(0);

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
      console.log("[Upload] Starting upload - blob size:", blob.size);
      const fd = new FormData();
      fd.append("file", new File([blob], "clip.webm", { type: blob.type || "audio/webm" }));
      const res = await fetch("/api/upload-audio", { method: "POST", body: fd });
      console.log("[Upload] Response status:", res.status);
      if (!res.ok) {
        console.warn("[Upload] Upload failed - status:", res.status);
        return null;
      }
      const data = await res.json();
      console.log("[Upload] Upload success - data:", data);
      return data?.url || data?.audioUrl || null;
    } catch (e) {
      console.warn("[Upload] Upload error:", e);
      return null;
    }
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
  
  // Create a better fallback audio - a short "user spoke" sound
  function createUserAudioFallback(): string {
    // Create a simple audio file and upload it once, then reuse the URL
    const fallbackBlob = synthBeepWav(0.5, 800); // 0.5 second, 800Hz tone
    uploadBlobGetUrl(fallbackBlob).then(url => {
      if (url) {
        console.log("[Fallback] Created user audio fallback:", url);
        // Store this URL for reuse
        (window as any).__userAudioFallback = url;
      }
    });
    return "/api/audio/test-user"; // Return the old fallback for now
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
        console.log("[Recorder] Blob created - size:", blob.size, "type:", blob.type);
        
        // Don't upload if the blob is too small (likely empty or just silence)
        if (blob.size < 1000) {
          console.warn("[Recorder] Blob too small, skipping upload:", blob.size, "bytes");
          resolveDone(null);
          return;
        }
        
        // Upload to persistent URL instead of creating blob URL
        const uploadedUrl = await uploadBlobGetUrl(blob);
        console.log("[Recorder] Upload result:", uploadedUrl);
        resolveDone(uploadedUrl);
      } catch (e) {
        console.warn("[Recorder] Upload failed:", e);
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

  let audioTrack;
  try {
    console.log("[LiveKit] Creating audio track...");
    audioTrack = await createLocalAudioTrack();
    console.log("[LiveKit] Audio track created successfully");
    await room.localParticipant.publishTrack(audioTrack);
    // keep a reference for per-turn user recording
    localMicTrackRef.current = audioTrack.mediaStreamTrack;
    console.log("[LiveKit] Audio track published to room");
  } catch (error: any) {
    console.error('LiveKit audio track creation failed:', error);
    console.log("[LiveKit] Error details:", error?.name, error?.message);
    // Continue without audio track - the call can still work for listening
    audioTrack = null;
  }

  // Local mic monitor (muted)
  const micEl = ensureAudioEl("micMonitor");
  micEl.muted = true;
  micEl.autoplay = true;
  // @ts-expect-error playsInline exists on HTMLMediaElement in browsers
  micEl.playsInline = true;
  try {
    if (audioTrack?.mediaStreamTrack) {
      micEl.srcObject = new MediaStream([audioTrack.mediaStreamTrack]);
      micEl.play?.().catch(() => {});
    }
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
    localTrack: audioTrack || null,
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
    // Simplified approach - just start everything and let it fail gracefully
    console.log("[Call] Starting call...");
    
    setIsInitializing(true);
    setInitError(null);
    
    // Add timeout to prevent hanging
    const callTimeout = setTimeout(() => {
      console.warn("[Call] Call setup timeout - continuing with limited functionality");
      setInitError("Call setup took longer than expected, but continuing...");
    }, 10000); // 10 second timeout
    
    try {
      // Start LiveKit first with timeout
      const livekitPromise = startLiveKitCall("test-user", "sales-sim");
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("LiveKit connection timeout")), 5000)
      );
      
      await Promise.race([livekitPromise, timeoutPromise]);
    } catch (error) {
      console.error("[Call] startLiveKitCall failed:", error);
      setInitError("Failed to connect to voice service, but continuing with limited functionality");
      // Continue anyway - might still work for mock mode
    } finally {
      clearTimeout(callTimeout);
    }

    if (!machineRef.current) machineRef.current = new CallMachine();
    const m = machineRef.current;
    m.start();
    setVoiceConnected(false);
    setTimeout(() => { m.answer(); setVoiceConnected(true); voiceConnectedRef.current = true; connectedAtRef.current = Date.now(); }, 1200);
    startedAtRef.current = Date.now();
    callIdRef.current = crypto.randomUUID();
    
    // Initialize waiting flag to true since we're waiting for user input after greeting
    waitingForUserRef.current = true;
    
    // Create fallback audio for user turns
    createUserAudioFallback();
    
    // Get microphone stream and initialize mic service
    try {
      console.log("[Mic] Getting microphone stream directly...");
      
      // Use the mic service to get the stream - this handles device selection better
      const stream = await mic.start();
      
      if (stream) {
        console.log("[Mic] Stream obtained via mic service:", stream);
        setMicStream(stream);
        micStreamRef.current = stream;
        
        // Try to start the mic service recording
        try {
          mic.startRecording();
          setIsRecording(true);
          console.log("[Mic] Recording started");
        } catch (recordingErr) {
          console.warn("[Mic] Recording failed, but stream is available:", recordingErr);
        }
      } else {
        throw new Error("Failed to get microphone stream");
      }
      
    } catch (err: any) { 
      console.error('Microphone access failed:', err); 
      console.log("[Mic] Error name:", err?.name);
      console.log("[Mic] Error message:", err?.message);
      
      if (err?.name === 'NotAllowedError') {
        setInitError("Microphone access denied. Please allow microphone access and try again.");
        alert('Please allow microphone access when prompted, then try again.');
      } else if (err?.name === 'NotFoundError') {
        setInitError("No microphone devices found. Please check your microphone connection and browser settings.");
        alert("No microphone devices detected. Please check your microphone connection and try again.");
      } else {
        setInitError("Failed to access microphone. The call may work with limited functionality.");
      }
    }
    
    // Agent greeting once connected (single guard)
    unsubRef.current = m.subscribe(async (state) => {
              if (state === "connected") {
          unsubRef.current?.();
          unsubRef.current = null;
        if (!greetedRef.current) {
          greetedRef.current = true;
          const greeting = currentScenario
            ? `Hi, this is ${currentScenario.persona}. ${currentScenario.brief.split(".")[0]}.`
            : "Hi, thanks for calling.";
          
          const useTtsStub = isMock || !voiceConnectedRef.current;
          let gurl: string | null = null;
          if (useTtsStub) {
            const r = await fetch("/api/tts", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: greeting }),
            });
            const j = r.ok ? await r.json() : null;
            gurl = j?.url ?? null;
          }
          
          pushTurn("agent", greeting, { audioUrl: useTtsStub ? gurl || undefined : undefined });
          
          // Play the greeting immediately using a dedicated audio element
          if (useTtsStub && gurl) {
            try {
              setAgentSpeaking(true);
              // Use a dedicated audio element for AI playback to reduce feedback
              const aiAudioEl = ensureAudioEl("aiAudio");
              aiAudioEl.src = gurl;
              aiAudioEl.volume = 0.8; // Slightly lower volume to reduce feedback
              
              // Set up event listener to handle when AI audio ends
              const handleAudioEnd = () => {
                setAgentSpeaking(false);
                aiAudioEl.removeEventListener('ended', handleAudioEnd);
              };
              aiAudioEl.addEventListener('ended', handleAudioEnd);
              
              await aiAudioEl.play();
              console.log("[LiveCall] Playing greeting:", gurl);
            } catch (e) {
              console.warn("[LiveCall] Failed to play greeting:", e);
            } finally {
              setAgentSpeaking(false);
            }
          }
          
          await new Promise((res) => setTimeout(res, 600 + Math.floor(Math.random() * 400)));
        }
                // start continuous web speech
        if (!speechRef.current) {
          speechRef.current = createWebSpeech({
            onSpeechStart: () => {
              console.log("[Speech] Speech started");
              pendingUserAudioRef.current = null;
              
              // Don't start recording if AI is speaking (microphone is disabled)
              if (agentSpeakingRef.current) {
                console.log("[UserAudio] Skipping recording - AI is speaking");
                attemptedRecordingRef.current = false;
                return;
              }
              
              // Start recording using the direct mic stream we already have
              try {
                
                // Get the mic stream from the ref, state, or mic service
                const stream = micStreamRef.current || micStream || mic.getStream();
                if (stream && stream.getAudioTracks().length > 0) {
                  // Check if the microphone track is enabled before recording
                  const audioTrack = stream.getAudioTracks()[0];
                  if (audioTrack.enabled && audioTrack.readyState === 'live') {
                    const { rec, done } = startRecorderForTrack(audioTrack);
                    userRecRef.current = rec;
                    userRecDoneRef.current = done;
                    attemptedRecordingRef.current = true;
                    console.log("[UserAudio] Started recording from mic stream");
                  } else {
                    console.warn("[UserAudio] Microphone track not ready - enabled:", audioTrack.enabled, "readyState:", audioTrack.readyState);
                    attemptedRecordingRef.current = false;
                  }
                } else {
                  console.warn("[UserAudio] No mic stream available for recording");
                  attemptedRecordingRef.current = false;
                }
              } catch (e) {
                console.warn("[UserAudio] Failed to start recording:", e);
                attemptedRecordingRef.current = false;
              }
              
              // Pause speech recognition while AI is speaking to prevent feedback
              if (agentSpeakingRef.current) {
                try {
                  speechRef.current?.stop();
                  console.log("[Speech] Paused during AI speech");
                } catch (e) {
                  console.warn("[Speech] Failed to pause:", e);
                }
              }
              
              // Also pause microphone recording during AI speech to reduce feedback
              if (agentSpeakingRef.current && userRecRef.current) {
                try {
                  userRecRef.current.pause();
                  console.log("[UserAudio] Paused recording during AI speech");
                } catch (e) {
                  console.warn("[UserAudio] Failed to pause recording:", e);
                }
              }
              
              // Also pause the mic service recording during AI speech
              if (agentSpeakingRef.current && mic.isActive()) {
                try {
                  mic.stopRecording();
                  console.log("[Mic] Stopped mic service recording during AI speech");
                } catch (e) {
                  console.warn("[Mic] Failed to stop mic service recording:", e);
                }
              }
              
              // Completely disable microphone during AI speech to prevent feedback
              if (agentSpeakingRef.current && micStreamRef.current) {
                try {
                  const audioTracks = micStreamRef.current.getAudioTracks();
                  audioTracks.forEach(track => {
                    track.enabled = false;
                  });
                  console.log("[Mic] Disabled microphone tracks during AI speech");
                } catch (e) {
                  console.warn("[Mic] Failed to disable microphone tracks:", e);
                }
              }
            },
            onSpeechEnd: async () => {
              // The recording is handled by the per-turn recorder, not the mic service
              console.log("[UserAudio] Speech ended, waiting for per-turn recording to complete");
            },
            onFinal: async (finalText) => {
              console.log("[Speech] Final text:", finalText);
              
              // Set the waiting flag to true since user has spoken and we're waiting for AI response
              waitingForUserRef.current = true;
              
              const words = finalText.split(/\s+/).filter(Boolean).length;
              const wpm = Math.round((words / 2) * 60); // rough fallback with 2s assumed
              // stop per-turn recorder and await object URL
              let turnUrl: string | null = pendingUserAudioRef.current || null;
              console.log("[UserAudio] Before stopping recorder - turnUrl:", turnUrl);
              try { userRecRef.current?.stop(); } catch {}
              try { 
                const recordedUrl = await userRecDoneRef.current;
                console.log("[UserAudio] After recording - recordedUrl:", recordedUrl);
                turnUrl = recordedUrl ?? turnUrl; 
              } catch (e) {
                console.warn("[UserAudio] Recording failed:", e);
              }
              userRecRef.current = null; userRecDoneRef.current = null;
              // Only use fallback if we actually tried to record but failed
              const audioUrl = turnUrl || (attemptedRecordingRef.current ? ((window as any).__userAudioFallback || "/api/audio/test-user") : null);
              attemptedRecordingRef.current = false; // Reset for next turn
              console.log("[UserAudio] Final audio URL for turn:", audioUrl);
              pushTurn("user", finalText, { wpm, audioUrl });
              console.log("[Turn:user]", { text: finalText.slice(0,40), audioUrl });
              pendingUserAudioRef.current = null;
              if (agentSpeakingRef.current) {
                stopSpeaking();
              }
                            if (currentScenario) {
                const currentTurnSeq = ++turnSeqRef.current;
                
                setTimeout(async () => {
                  // Check if this turn is still valid (not superseded by interruption)
                  if (currentTurnSeq !== turnSeqRef.current) {
                    console.log("[Turn:agent] Turn superseded, skipping");
                    return;
                  }
                  
                  // Add a longer delay to prevent rapid feedback loops
                  await new Promise(resolve => setTimeout(resolve, 1000));
                  
                  // Prevent AI from responding if the last turn was from AI
                  const lastTurn = historyRef.current[historyRef.current.length - 1];
                  const lastTurnWasAgent = lastTurn && lastTurn.role === "agent";
                  
                  // Check if we've had too many consecutive agent turns (prevent infinite loops)
                  const recentTurns = historyRef.current.slice(-3);
                  const tooManyAgentTurns = recentTurns.length >= 3 && recentTurns.every(t => t.role === "agent");
                  
                  // Only respond if the last turn was from user AND we haven't had too many agent turns
                  // AND we're actually waiting for user input AND AI is not currently speaking
                  const shouldRespond = !lastTurnWasAgent && !tooManyAgentTurns && waitingForUserRef.current && !agentSpeakingRef.current;
                  
                  console.log("[AI] Response check:", { 
                    lastTurnRole: lastTurn?.role, 
                    lastTurnWasAgent, 
                    tooManyAgentTurns, 
                    waitingForUser: waitingForUserRef.current,
                    shouldRespond 
                  });
                  
                  if (shouldRespond) {
                    // Set flag to false since AI is now responding
                    waitingForUserRef.current = false;
                    
                    // Generate AI response based on mode
                    let reply: string;
                    if (isMock) {
                      // Use mock agent in mock mode
                      reply = getAgentReply(historyRef.current, currentScenario);
                      console.log("[AI] Generated mock reply:", reply);
                    } else {
                      // Use real AI in live mode
                      try {
                        console.log("[AI] Calling OpenAI API for live response");
                        const messages = historyRef.current.map(turn => ({
                          role: turn.role,
                          text: turn.text
                        }));
                        
                        const response = await fetch("/api/chat", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ 
                            messages,
                            scenario: currentScenario
                          })
                        });
                        
                        if (response.ok) {
                          const data = await response.json();
                          reply = data.content || "I didn't catch that. Could you please repeat?";
                          console.log("[AI] Generated live AI reply:", reply);
                        } else {
                          console.warn("[AI] OpenAI API failed, falling back to mock");
                          reply = getAgentReply(historyRef.current, currentScenario);
                        }
                      } catch (error) {
                        console.warn("[AI] OpenAI API error, falling back to mock:", error);
                        reply = getAgentReply(historyRef.current, currentScenario);
                      }
                    }
                    
                    // Start per-turn agent recorder as soon as we have remote track
                    if (!agentRecRef.current && agentTrackRef.current) {
                      try {
                        const { rec, done } = startRecorderForTrack(agentTrackRef.current);
                        agentRecRef.current = rec;
                        agentRecDoneRef.current = done;
                      } catch {}
                    }
                    
                    // Real TTS pipeline: call /api/tts (stub returns seeded URL)
                    const useTtsStub = isMock || !voiceConnectedRef.current;
                    let aurl: string | null = null;
                    if (useTtsStub) {
                      try {
                        const r = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: reply }) });
                        if (r.ok) { const j = await r.json(); aurl = j?.url ?? null; }
                      } catch {}
                    }
                    
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
                      pushTurn("agent", reply, { audioUrl: useTtsStub ? aurl : undefined });
                      console.log("[Turn:assistant]", { text: reply.slice(0,40), audioUrl: aurl });
                      
                      // Play the AI response during the live call
                      if (useTtsStub && aurl) {
                        try {
                          // Completely stop speech recognition while AI speaks
                          if (speechRef.current) {
                            try {
                              speechRef.current.stop();
                              console.log("[Speech] Stopped for AI response");
                            } catch (e) {
                              console.warn("[Speech] Failed to stop:", e);
                            }
                          }
                          
                          setAgentSpeaking(true);
                          // Use dedicated audio element for AI response to reduce feedback
                          const aiResponseEl = ensureAudioEl("aiResponse");
                          aiResponseEl.src = aurl;
                          aiResponseEl.volume = 0.7; // Lower volume to reduce feedback
                          
                          // Set up event listener to handle when AI audio ends
                          const handleResponseEnd = () => {
                                                      setAgentSpeaking(false);
                          aiResponseEl.removeEventListener('ended', handleResponseEnd);
                          // Restart speech recognition after a longer delay to prevent feedback
                          setTimeout(() => {
                            try {
                              if (speechRef.current && !agentSpeakingRef.current) {
                                speechRef.current.start();
                                console.log("[Speech] Restarted after AI response");
                              }
                            } catch (e) {
                              console.warn("[Speech] Failed to restart:", e);
                            }
                          }, 3000); // 3 second delay to prevent feedback
                          };
                          aiResponseEl.addEventListener('ended', handleResponseEnd);
                          
                          await aiResponseEl.play();
                          console.log("[LiveCall] Playing AI response:", aurl);
                        } catch (e) {
                          console.warn("[LiveCall] Failed to play AI response:", e);
                          agentSpeakingRef.current = false;
                        }
                      }
                    } else {
                      // No TTS and no recording — skip pushing empty audio to avoid mic re-records
                      console.warn("No TTS or recording available — skipping agent audio for this turn");
                    }
                  }

                  await new Promise((resolve) => setTimeout(resolve, 600 + Math.floor(Math.random() * 400)));
                  // Only restart speech recognition if AI is not speaking
                  if (!agentSpeakingRef.current) {
                    try { speechRef.current?.start(); } catch {}
                  }
                });
              }
            }
          });
        }
        // Start speech recognition after a delay to avoid picking up the greeting
        setTimeout(() => {
          console.log("[Speech] Starting speech recognition after delay");
          // Only start speech recognition if we have a working microphone
          if (micStreamRef.current && micStreamRef.current.getAudioTracks().length > 0) {
            const audioTrack = micStreamRef.current.getAudioTracks()[0];
            if (audioTrack.enabled && audioTrack.readyState === 'live') {
              try { 
                speechRef.current?.start(); 
                console.log("[Speech] Speech recognition started successfully");
              } catch (e) {
                console.warn("[Speech] Failed to start speech recognition:", e);
              }
            } else {
              console.warn("[Speech] Microphone not ready, skipping speech recognition");
            }
          } else {
            console.warn("[Speech] No microphone stream available, skipping speech recognition");
          }
        }, 4000); // 4 second delay to let greeting finish and prevent feedback
      }
    });
    
    // Clear loading state
    setIsInitializing(false);
  }

  async function handleEnd() {
    // Clean up subscriptions
    try { unsubRef.current?.(); } catch {}
    unsubRef.current = null;
    
    // Stop all recorders
    try { userRecRef.current?.stop(); } catch {}
    try { agentRecRef.current?.stop(); } catch {}
    userRecRef.current = null;
    agentRecRef.current = null;
    userRecDoneRef.current = null;
    agentRecDoneRef.current = null;
    
    // Stop speech and mic
    try { speechRef.current?.stop(); } catch {}
    try {
      if (isRecording) {
        const blob = await mic.stopRecording();
        setIsRecording(false);
        if (blob) setAudioUrl(URL.createObjectURL(blob));
      }
    } catch {}
    mic.stop();
    
    // End LiveKit call
    await endLiveKitCall();
    stopSpeaking();
    
    // Force stop all audio elements
    const audioElements = document.querySelectorAll('audio');
    audioElements.forEach(audio => {
      try {
        audio.pause();
        audio.currentTime = 0;
        audio.src = '';
      } catch (e) {
        console.warn("[EndCall] Failed to stop audio element:", e);
      }
    });
    
    // Reset state
    const m = machineRef.current;
    m?.end();
    setVoiceConnected(false);
    voiceConnectedRef.current = false;
    greetedRef.current = false;
    agentSpeakingRef.current = false;
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
    
    // Clean up all audio and speech before navigating
    console.log("[EndCall] Cleaning up before navigation...");
    try {
      // Stop any ongoing speech recognition
      if (speechRef.current) {
        try {
          speechRef.current.stop();
        } catch (e) {
          console.warn("[EndCall] Failed to stop speech:", e);
        }
        speechRef.current = null;
      }
      
      // Stop mic service
      try {
        await mic.stop();
        setMicStream(null);
      } catch (e) {
        console.warn("[EndCall] Failed to stop mic:", e);
      }
      
      // Clear recorder references
      userRecRef.current = null;
      agentRecDoneRef.current = null;
      agentRecRef.current = null;
      agentRecDoneRef.current = null;
      
      // Stop any playing audio
      if (agentSpeakingRef.current) {
        stopSpeaking();
        agentSpeakingRef.current = false;
      }
      
      // Force stop all audio elements
      const audioElements = document.querySelectorAll('audio');
      audioElements.forEach(audio => {
        try {
          audio.pause();
          audio.currentTime = 0;
          audio.src = '';
        } catch (e) {
          console.warn("[EndCall] Failed to stop audio element:", e);
        }
      });
      
      // Disconnect from LiveKit
      if (roomRef.current) {
        await roomRef.current.disconnect();
        roomRef.current = null;
      }
      
          console.log("[EndCall] Cleanup complete");
  } catch (e) {
    console.warn("[EndCall] Cleanup error:", e);
  }
  
  console.log("[EndCall] Navigating to review page:", `/review?id=${id}`);
  try {
    await router.push(`/review?id=${id}`);
    console.log("[EndCall] Navigation successful");
  } catch (e) {
    console.error("[EndCall] Navigation failed:", e);
    // Fallback: try to navigate manually
    window.location.href = `/review?id=${id}`;
  }
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
        <CallBar state={voiceConnected ? "connected" : "idle"} onCall={handleCall} onEnd={handleEnd} stream={micStream} isInitializing={isInitializing} />
        
        {/* Loading and error states */}
        {isInitializing && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
            <div className="flex items-center gap-2">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
              <div>Initializing call... Please wait.</div>
            </div>
          </div>
        )}
        
        {initError && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            <div className="flex items-start gap-2">
              <div className="mt-0.5">⚠️</div>
              <div>
                <div>{initError}</div>
                <div className="mt-2 text-xs text-red-700">
                  <strong>Troubleshooting:</strong>
                  <ul className="mt-1 space-y-1">
                    <li>• Make sure your browser allows microphone access</li>
                    <li>• Try clicking "Test Mic" to check microphone access</li>
                    <li>• Try clicking "Restart Mic" to reset the microphone</li>
                    <li>• Check if another app is using your microphone</li>
                    <li>• Try refreshing the page and allowing microphone access when prompted</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        )}
        
        <div className="-mt-4 flex justify-end px-1 text-[11px] text-gray-500">
          <div className="flex items-center gap-2">
            <span>Mic: {micStatus}</span>
            {micStream && (
              <span className={`inline-flex items-center gap-1 px-1 rounded text-xs ${
                micStream.getAudioTracks()[0]?.readyState === 'live' 
                  ? 'bg-green-100 text-green-700' 
                  : 'bg-red-100 text-red-700'
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${
                  micStream.getAudioTracks()[0]?.readyState === 'live' 
                    ? 'bg-green-500' 
                    : 'bg-red-500'
                }`}></span>
                {micStream.getAudioTracks()[0]?.readyState === 'live' ? 'Live' : 'Not Ready'}
              </span>
            )}
          </div>
          {(micStatus === 'blocked' || micStatus === 'error') && (
            <>
              <button
                onClick={async () => {
                  try {
                    console.log("[Mic] Manual permission request...");
                    await navigator.mediaDevices.getUserMedia({ audio: true });
                    console.log("[Mic] Permission granted manually");
                    // Retry mic start
                    const stream = await mic.start();
                    if (stream) {
                      setMicStream(stream);
                      mic.startRecording();
                      setIsRecording(true);
                      console.log("[Mic] Successfully started microphone after manual permission");
                    }
                  } catch (err) {
                    console.error('[Mic] Manual permission request failed:', err);
                    alert('Please allow microphone access in your browser settings.');
                  }
                }}
                className="ml-2 text-blue-600 hover:text-blue-800 underline"
              >
                Allow Mic
              </button>
              <button
                onClick={async () => {
                  try {
                    console.log("[Mic] Force mic restart...");
                    // Stop any existing mic
                    mic.stop();
                    // Force new permission request
                    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    setMicStream(stream);
                    // Try to start mic service again
                    const micStream = await mic.start();
                    if (micStream) {
                      mic.startRecording();
                      setIsRecording(true);
                      console.log("[Mic] Force restart successful");
                    }
                  } catch (err) {
                    console.error('[Mic] Force restart failed:', err);
                  }
                }}
                className="ml-2 text-red-600 hover:text-red-800 underline"
              >
                Force Mic
              </button>
            </>
          )}
          {micStatus === 'idle' && (
            <span className="ml-2 text-gray-400">Click "Start Call" to activate</span>
          )}
        </div>
        
        {/* Audio feedback warning */}
        {voiceConnected && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <div className="flex items-start gap-2">
              <div className="mt-0.5 text-amber-600">🔊</div>
              <div>
                <div className="font-medium">Audio Feedback Notice</div>
                <div className="text-xs text-amber-700 mt-1">
                  For best results, use headphones to prevent the AI's voice from being picked up by your microphone. 
                  The system includes echo cancellation, but headphones will provide the clearest experience.
                </div>
              </div>
            </div>
          </div>
        )}
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
            <button
              type="button"
              onClick={async () => {
                console.log("=== MICROPHONE DEBUG INFO ===");
                console.log("[Debug] Mic status:", micStatus);
                console.log("[Debug] Mic stream:", mic.getStream());
                console.log("[Debug] Mic active:", mic.isActive());
                console.log("[Debug] Mic stream state:", mic.getStream()?.active);
                console.log("[Debug] Mic stream tracks:", mic.getStream()?.getTracks().map(t => ({ id: t.id, kind: t.kind, enabled: t.enabled, readyState: t.readyState })));
                
                console.log("[Debug] Available devices:");
                const devices = await navigator.mediaDevices.enumerateDevices();
                const audioDevices = devices.filter(d => d.kind === 'audioinput');
                console.log("[Debug] Audio devices:", audioDevices.map(d => ({ deviceId: d.deviceId, label: d.label, groupId: d.groupId })));
                
                if (audioDevices.length === 0) {
                  console.warn("[Debug] NO AUDIO DEVICES FOUND!");
                  alert("No microphone devices detected. Please check your microphone connection.");
                } else {
                  console.log("[Debug] Found", audioDevices.length, "audio device(s)");
                  audioDevices.forEach((device, index) => {
                    console.log(`[Debug] Device ${index + 1}:`, {
                      label: device.label || "Unknown device",
                      deviceId: device.deviceId,
                      groupId: device.groupId
                    });
                  });
                }
                
                console.log("[Debug] LiveKit room:", roomRef.current);
                console.log("[Debug] Local mic track:", localMicTrackRef.current);
                
                // Test direct getUserMedia
                try {
                  console.log("[Debug] Testing direct getUserMedia...");
                  const testStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                  console.log("[Debug] Direct getUserMedia succeeded:", testStream);
                  testStream.getTracks().forEach(track => track.stop());
                } catch (err) {
                  console.error("[Debug] Direct getUserMedia failed:", err);
                }
                
                console.log("=== END DEBUG INFO ===");
              }}
              className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
            >
              Debug Mic
            </button>
            <button
              type="button"
              onClick={async () => {
                try {
                  console.log("[Test] Testing microphone access...");
                  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                  console.log("[Test] SUCCESS! Microphone access granted");
                  console.log("[Test] Stream:", stream);
                  console.log("[Test] Tracks:", stream.getTracks());
                  
                  // Test if the microphone is actually working by checking the audio track
                  const audioTrack = stream.getAudioTracks()[0];
                  if (audioTrack && audioTrack.readyState === 'live') {
                    alert("✅ Microphone test successful! Your microphone is working properly.");
                  } else {
                    alert("⚠️ Microphone access granted but track not ready. Try refreshing the page.");
                  }
                  
                  stream.getTracks().forEach(track => track.stop());
                } catch (err) {
                  console.error("[Test] FAILED! Microphone access denied:", err);
                  alert("❌ Microphone test failed. Please check your browser settings and allow microphone access.");
                }
              }}
              className="rounded-md border border-green-300 px-2 py-1 text-xs text-green-700 hover:bg-green-50"
            >
              Test Mic
            </button>
            <button
              type="button"
              onClick={async () => {
                try {
                  console.log("[DeviceSelect] Opening device selector...");
                  const devices = await navigator.mediaDevices.enumerateDevices();
                  const audioDevices = devices.filter(d => d.kind === 'audioinput');
                  
                  if (audioDevices.length === 0) {
                    alert("No microphone devices found. Please check your microphone connection.");
                    return;
                  }
                  
                  if (audioDevices.length === 1) {
                    alert(`Found 1 microphone: ${audioDevices[0].label || 'Unknown device'}`);
                    return;
                  }
                  
                  // Create a simple device selector
                  const deviceList = audioDevices.map((device, index) => 
                    `${index + 1}. ${device.label || 'Unknown device'}`
                  ).join('\n');
                  
                  const selection = prompt(
                    `Found ${audioDevices.length} microphone(s):\n\n${deviceList}\n\nEnter the number of the device you want to use (1-${audioDevices.length}):`
                  );
                  
                  const deviceIndex = parseInt(selection || '') - 1;
                  if (deviceIndex >= 0 && deviceIndex < audioDevices.length) {
                    const selectedDevice = audioDevices[deviceIndex];
                    console.log("[DeviceSelect] Selected device:", selectedDevice);
                    
                    // Try to access the selected device
                    try {
                      const stream = await navigator.mediaDevices.getUserMedia({
                        audio: {
                          deviceId: { exact: selectedDevice.deviceId },
                          echoCancellation: true,
                          noiseSuppression: true,
                          autoGainControl: true
                        }
                      });
                      
                      // Update the current microphone stream
                      if (micStreamRef.current) {
                        micStreamRef.current.getTracks().forEach(track => track.stop());
                      }
                      
                      setMicStream(stream);
                      micStreamRef.current = stream;
                      mic.setStream(stream);
                      
                      try {
                        mic.startRecording();
                        setIsRecording(true);
                        console.log("[DeviceSelect] Recording started with selected device");
                        alert(`✅ Successfully switched to: ${selectedDevice.label || 'Unknown device'}`);
                      } catch (recordingErr) {
                        console.warn("[DeviceSelect] Recording failed:", recordingErr);
                        alert(`⚠️ Device switched but recording failed: ${selectedDevice.label || 'Unknown device'}`);
                      }
                    } catch (deviceErr) {
                      console.error("[DeviceSelect] Failed to access selected device:", deviceErr);
                      alert(`❌ Failed to access selected device: ${selectedDevice.label || 'Unknown device'}`);
                    }
                  } else {
                    alert("Invalid selection. Please try again.");
                  }
                } catch (err) {
                  console.error("[DeviceSelect] Error:", err);
                  alert("❌ Error accessing device list. Please check your browser settings.");
                }
              }}
              className="rounded-md border border-purple-300 px-2 py-1 text-xs text-purple-700 hover:bg-purple-50"
            >
              Select Device
            </button>
            <button
              type="button"
              onClick={async () => {
                try {
                  console.log("[Restart] Manually restarting microphone...");
                  
                  // Stop any existing microphone
                  mic.stop();
                  if (micStreamRef.current) {
                    micStreamRef.current.getTracks().forEach(track => track.stop());
                    micStreamRef.current = null;
                  }
                  setMicStream(null);
                  setIsRecording(false);
                  
                  // Wait a moment
                  await new Promise(resolve => setTimeout(resolve, 500));
                  
                  // Try to get microphone access again
                  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                  console.log("[Restart] Microphone restarted successfully:", stream);
                  setMicStream(stream);
                  micStreamRef.current = stream;
                  mic.setStream(stream);
                  
                  try {
                    mic.startRecording();
                    setIsRecording(true);
                    console.log("[Restart] Recording started after restart");
                    alert("✅ Microphone restarted successfully!");
                  } catch (recordingErr) {
                    console.warn("[Restart] Recording failed after restart:", recordingErr);
                    alert("⚠️ Microphone restarted but recording failed. The mic should still work for speech recognition.");
                  }
                } catch (err) {
                  console.error("[Restart] Failed to restart microphone:", err);
                  alert("❌ Failed to restart microphone. Please check your browser settings.");
                }
              }}
              className="rounded-md border border-blue-300 px-2 py-1 text-xs text-blue-700 hover:bg-blue-50"
            >
              Restart Mic
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
  
  // Cleanup on unmount
  useEffect(() => {
    return () => {
      console.log("[Cleanup] Cleaning up session resources...");
      
      // Stop LiveKit
      try { 
        roomRef.current?.disconnect(); 
      } catch (e) {
        console.warn("[Cleanup] LiveKit disconnect error:", e);
      }
      
      // Stop speech recognition
      try {
        speechRef.current?.stop();
      } catch (e) {
        console.warn("[Cleanup] Speech stop error:", e);
      }
      
      // Stop mic service
      try {
        mic.stop();
      } catch (e) {
        console.warn("[Cleanup] Mic stop error:", e);
      }
      
      // Stop any playing audio
      const audioElements = document.querySelectorAll('audio');
      audioElements.forEach(audio => {
        try {
          audio.pause();
          audio.currentTime = 0;
          audio.src = '';
        } catch (e) {}
      });
      
      console.log("[Cleanup] Cleanup completed");
    };
  }, []);
}

export default function SessionPage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-gray-50" />}> 
      <SessionInner />
    </Suspense>
  );
}


