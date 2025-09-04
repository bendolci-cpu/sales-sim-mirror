"use client";

import React, { useRef, useState, useEffect, Suspense } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import ClientOnly from "@/components/ClientOnly";
const ChatWindowClient = dynamic(() => import("@/components/ChatWindow"), { ssr: false });
import BudgetBadge from "@/components/BudgetBadge";
import ScenarioPicker from "@/components/ScenarioPicker";
import { SCENARIOS } from "@/data/scenarios";
import { getAgentReply } from "@/lib/voice/mockAgent";
import CallBar from "@/components/CallBar";
import DebugToggle from "@/components/DebugToggle";
import AudioDeviceSelector from "@/components/AudioDeviceSelector";
import { logInfo, logError } from "@/lib/logger";
import { registerMessageHandler, unregisterMessageHandler, connectMessageDispatcher, disconnectMessageDispatcher, setMuted, isMuted } from "@/lib/messageDispatcher";
import { getUnifiedAudioPipeline, cleanupUnifiedAudioPipeline, useAudioDebugOverlay } from "@/lib/unifiedAudioPipeline";
import { Room } from "livekit-client";
import type { MessageRequest, MessageResponse } from "@/lib/messageDispatcher";

// Helper function to connect LiveKit with existing mic track
async function connectToLiveKitWithMicTrack(room: Room, micTrack: MediaStreamTrack): Promise<import('livekit-client').LocalTrackPublication | undefined> {
  try {
    // Publish the existing mic track directly to LiveKit
    const publication = await room.localParticipant.publishTrack(micTrack);
    
    logInfo(`[LiveKit] Published mic track: ${micTrack.id}`);
    return publication;
  } catch (error) {
    logError("[LiveKit] Failed to publish mic track:", error);
    throw error;
  }
}

interface Turn {
  id: string;
  role: "user" | "agent";
  text: string;
  timestamp: number;
}

function SessionInner() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  
  // URL parameters
  const mode = searchParams.get("mode") || "practice";
  const isMock = searchParams.get("mock") === "1";
  const scenarioId = searchParams.get("scenario") || "cdi-outbreak-icu";
  const showChat = searchParams.get("chat") === "1";
  
  // State
  const [voiceConnected, setVoiceConnected] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [isToggling, setIsToggling] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [externalTurn, setExternalTurn] = useState<{ role: "user" | "bot"; text: string; timestamp: number } | null>(null);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [micTrack, setMicTrack] = useState<MediaStreamTrack | null>(null);
  const [publishedTrackId, setPublishedTrackId] = useState<string | null>(null);
  
  // Debug overlay state
  const [lastASRText, setLastASRText] = useState<string>("");
  const [currentMuteState, setCurrentMuteState] = useState<boolean>(false);
  
  // Use the centralized debug overlay hook
  const audioDebugInfo = useAudioDebugOverlay();
  
  // Refs
  const unifiedPipeline = useRef<ReturnType<typeof getUnifiedAudioPipeline> | null>(null);
  const livekitRoom = useRef<Room | null>(null);
  const callEndedRef = useRef(false);
  const scenario = SCENARIOS.find(s => s.id === scenarioId);
  
  // Initialize pipeline on client side only
  useEffect(() => {
    if (typeof window !== 'undefined') {
      unifiedPipeline.current = getUnifiedAudioPipeline({
        onMicTrackReady: (track) => {
          setMicTrack(track);
          logInfo(`[Session] Mic track ready: ${track.id}`);
        },
        onBargeIn: () => {
          logInfo('[Session] Barge-in triggered');
          // Unmute dispatcher so next user speech can be sent
          setMuted(false);
        },
        onTTSStart: () => {
          logInfo(`[Session] TTS started`);
          // Mute dispatcher during TTS to prevent false triggers
          setMuted(true);
        },
        onTTSEnd: () => {
          logInfo(`[TTS] end ${Date.now()}`);
          // Unmute dispatcher when TTS ends naturally
          setMuted(false);
          // Don't auto-end the call - keep it connected
        },
        onTTSError: (error) => {
          logError('[Session] TTS error:', error);
        },
        onFinalResult: (text) => {
          logInfo(`[ASR] final ${text} ${Date.now()}`);
          setLastASRText(text);
          // Handle speech recognition results here
        },
        onError: (error) => {
          logError('[Session] Speech recognition error:', error);
        }
      });
    }
  }, []);
  
  // Debug overlay polling
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentMuteState(isMuted());
    }, 200);

    return () => clearInterval(interval);
  }, []);

  // === MESSAGE DISPATCHER HANDLER ===
  
  const handleMessageDispatcher = async (request: MessageRequest): Promise<MessageResponse> => {
    const { text, metadata } = request;
    const turnId = crypto.randomUUID();
    
    logInfo(`[Session] Processing message: "${text}" (${metadata.source})`);
    
    // Add user turn
    const userTurn: Turn = {
      id: turnId,
      role: "user",
      text,
      timestamp: Date.now()
    };
    setTurns(prev => [...prev, userTurn]);
    
    // Generate AI response
    try {
      let aiResponse: string;
      
      if (isMock) {
        aiResponse = getAgentReply([...turns, userTurn], scenario || SCENARIOS[0]);
        logInfo(`[Session] Generated mock response: ${aiResponse}`);
      } else {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [...turns, userTurn].map(turn => ({
              role: turn.role,
              text: turn.text
            }))
          })
        });
        
        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }
        
        const data = await response.json();
        aiResponse = data.content || data.response || "I didn't catch that. Could you please repeat?";
        logInfo(`[Session] Generated live response: ${aiResponse}`);
      }
      
      // Add AI turn
      const aiTurn: Turn = {
        id: crypto.randomUUID(),
        role: "agent",
        text: aiResponse,
        timestamp: Date.now()
      };
      setTurns(prev => [...prev, aiTurn]);
      
      // Update external turn for chat window
      setExternalTurn({
        role: "bot",
        text: aiResponse,
        timestamp: aiTurn.timestamp
      });
      
      // Play TTS if connected
      if (voiceConnected && !isMock && unifiedPipeline.current) {
        try {
          const turnId = aiTurn.id;
          await unifiedPipeline.current.playTTS(aiResponse, turnId);
        } catch (error) {
          logError(`[Session] TTS failed for turn ${aiTurn.id}:`, error);
        }
      }
      
      return {
        id: turnId,
        text: aiResponse,
        success: true
      };
      
    } catch (error) {
      logError(`[Session] Failed to generate AI response:`, error);
      return {
        id: turnId,
        text: '',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  };
  
  // === CALL MANAGEMENT ===
  
  const handleCall = async () => {
    if (voiceConnected) return;
    
    logInfo("[Session] Starting call");
    setIsInitializing(true);
    callEndedRef.current = false;
    
    try {
      // Initialize unified pipeline
      if (!unifiedPipeline.current) {
        throw new Error("Pipeline not initialized");
      }
      logInfo("[Session] Initializing unified pipeline...");
      await unifiedPipeline.current.initialize();
      logInfo("[Session] Unified pipeline initialized successfully");
      
      // Fix mic race - don't join LiveKit until a real mic track exists
      const micTrack = await unifiedPipeline.current.ensureMicTrack();
      if (!micTrack) {
        logError('[Session] No mic track after ensureMicTrack');
        return;
      }
      logInfo('[Session] Mic track ready', { id: micTrack.id || micTrack.getSettings?.()?.deviceId });
      
      // Get mic stream for UI
      const stream = unifiedPipeline.current.getMicStream();
      setMicStream(stream);
      
      // Connect to LiveKit if not in mock mode
      if (!isMock) {
        await connectToLiveKit(micTrack);
      }
      
      // Connect message dispatcher after successful LiveKit connection (or if mock mode)
      connectMessageDispatcher();
      logInfo("[Session] Message dispatcher connected");
      
      // Start speech recognition (only if call hasn't ended)
      if (unifiedPipeline.current && !callEndedRef.current) {
        unifiedPipeline.current.startSpeech();
        logInfo("[Session] Speech recognition started");
      }
      
      setVoiceConnected(true);
      logInfo("[Session] Call started successfully");
      
      // Play greeting if available
      const greeting = scenario?.starterMessages?.[0];
      if (greeting) {
        logInfo(`[Session] Playing greeting: "${greeting}"`);
        const greetingTurn: Turn = {
          id: crypto.randomUUID(),
          role: "agent",
          text: greeting,
          timestamp: Date.now()
        };
        setTurns([greetingTurn]);
        setExternalTurn({
          role: "bot",
          text: greeting,
          timestamp: greetingTurn.timestamp
        });
        
        if (!isMock) {
          try {
            logInfo("[Session] Starting TTS for greeting...");
            const greetingTurnId = greetingTurn.id;
            
            // Wrap TTS with mute gating and guarantee unmute and restart recognition
            setMuted(true);
            try {
              await unifiedPipeline.current.playTTS(greeting, greetingTurnId);
            } finally {
              setMuted(false);
              // Restart recognition after greeting finishes
              if (unifiedPipeline.current) {
                unifiedPipeline.current.startSpeech();
              }
            }
            
            logInfo("[Session] Greeting TTS completed");
          } catch (error) {
            logError(`[Session] Greeting TTS failed:`, error);
          }
        } else {
          logInfo("[Session] Mock mode - skipping TTS");
        }
      } else {
        logInfo("[Session] No greeting available");
      }
      
    } catch (error) {
      logError("[Session] Failed to start call:", error);
    } finally {
      setIsInitializing(false);
    }
  };
  
  const connectToLiveKit = async (micTrack: MediaStreamTrack) => {
    // Add guard at the very top of LiveKit connect that throws a clear error if micTrack is missing
    if (!micTrack) {
      throw new Error('No mic track available for LiveKit');
    }
    
    try {
      // Create LiveKit room
      livekitRoom.current = new Room();
      
      // Fetch LiveKit token from our API
      const res = await fetch("/api/livekit-token?name=test-user&room=sales-sim");
      
      if (!res.ok) {
        throw new Error(`Token fetch failed: ${res.status}`);
      }
      
      const { token } = await res.json();
      if (!token) {
        throw new Error('No token received from LiveKit token API');
      }
      
      // Connect to room with proper token
      const roomUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;
      if (!roomUrl) {
        throw new Error('NEXT_PUBLIC_LIVEKIT_URL not configured');
      }
      
      await livekitRoom.current.connect(roomUrl, token);
      
      // Use the helper function to publish the pipeline's mic track
      const publication = await connectToLiveKitWithMicTrack(livekitRoom.current, micTrack);
      
      if (publication?.trackSid) {
        setPublishedTrackId(publication.trackSid);
        logInfo(`[Session] Published track: ${publication.trackSid}`);
        
        // Log track IDs for debugging - should be equal since we're using the same track
        logInfo(`[Mic/Publish] ids {micTrackId: ${micTrack.id}, publishedTrackId: ${publication.trackSid}, equal: ${micTrack.id === publication.trackSid}}`);
      }
      
      logInfo("[Session] Connected to LiveKit room");
      
    } catch (error) {
      logError("[Session] Failed to connect to LiveKit:", error);
    }
  };
  
  const handleEnd = () => {
    if (!voiceConnected) return;
    
    logInfo("[Session] DISCONNECT_REASON:user_explicit_end");
    callEndedRef.current = true;
    
    // Disconnect from LiveKit
    if (livekitRoom.current) {
      livekitRoom.current.disconnect();
      livekitRoom.current = null;
    }
    
    // Stop speech recognition (only if call hasn't ended)
    if (unifiedPipeline.current && !callEndedRef.current) {
      unifiedPipeline.current.stopSpeech();
    }
    
    // Force cleanup unified pipeline (close AudioContext)
    if (unifiedPipeline.current) {
      unifiedPipeline.current.forceCleanup();
      unifiedPipeline.current = null;
    }
    
    // Disconnect message dispatcher
    disconnectMessageDispatcher();
    
    setVoiceConnected(false);
    setMicStream(null);
    setMicTrack(null);
    setPublishedTrackId(null);
    setTurns([]);
    setExternalTurn(null);
    
    logInfo("[Session] Call ended");
  };

  // === CHAT HANDLERS ===

  const handleChatUserUtterance = async (text: string) => {
    if (!unifiedPipeline.current) return;
    
    const response = await handleMessageDispatcher({
      text,
              metadata: {
          source: 'text',
          timestamp: Date.now()
        }
    });
    
    if (response?.success) {
      logInfo(`[Session] Chat message processed: "${text}"`);
    } else {
      logError(`[Session] Chat message failed: "${text}"`);
    }
  };

  // === EFFECTS ===

  useEffect(() => {
    // Register message handler
    registerMessageHandler(handleMessageDispatcher);
    
    return () => {
      unregisterMessageHandler(handleMessageDispatcher);
    };
  }, []);

  useEffect(() => {
    // Cleanup on unmount
    return () => {
      if (unifiedPipeline.current) {
        unifiedPipeline.current.cleanup();
      }
    };
  }, []);

  if (!scenario) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <h1 className="text-xl font-semibold text-red-600">Scenario Not Found</h1>
          <p className="text-gray-600">Scenario ID: {scenarioId}</p>
        </div>
      </div>
    );
  }

  return (
    <main className="flex min-h-screen flex-col bg-gray-50">
      <div className="flex-1 p-6">
        <div className="mx-auto max-w-4xl">
          
          {/* Header */}
          <div className="mb-8 flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Sales Simulation</h1>
                              <p className="text-gray-600">
                  {scenario.title} • {scenario.persona}
                </p>
            </div>
            <div className="flex items-center gap-4">
              <BudgetBadge />
              <DebugToggle />
              <button
                onClick={async () => {
                  if (voiceConnected) {
                    handleEnd();
                  } else {
                    await handleCall();
                  }
                }}
                disabled={isInitializing}
                className={`rounded-lg px-4 py-2 font-medium text-white transition-colors ${
                  voiceConnected
                    ? 'bg-red-600 hover:bg-red-700'
                    : 'bg-blue-600 hover:bg-blue-700'
                } disabled:opacity-50`}
              >
                {isInitializing
                  ? 'Initializing...'
                  : voiceConnected
                  ? 'End Call'
                  : `Start ${mode === 'practice' ? 'Practice' : 'Challenge'} Session`}
              </button>
            </div>
          </div>

          {/* Scenario Picker */}
          <div className="mb-6">
            <ScenarioPicker onChange={() => {}} />
          </div>

          {/* Main Content */}
          <div className="flex flex-col gap-6">
            <CallBar
              state={voiceConnected ? "connected" : "idle"}
              onCall={handleCall}
              onEnd={handleEnd}
              isInitializing={isInitializing}
            />
            
            {/* Chat Window */}
            {showChat && (
              <div className="rounded-lg border border-gray-200 bg-white p-4">
                <ChatWindowClient
                  visible={showChat}
                  externalTurn={externalTurn}
                  onUserUtterance={handleChatUserUtterance}
                />
              </div>
            )}

            {/* Audio Device Selector */}
            <AudioDeviceSelector />

            {/* Pipeline Status */}
            <div className="rounded-lg border border-green-200 bg-green-50 p-4">
              <h3 className="text-sm font-medium text-green-900 mb-2">Pipeline Status</h3>
              <div className="text-sm text-green-800 space-y-1">
                <div>TTS: {unifiedPipeline.current?.isTTSPlaying() ? "Playing" : "Idle"}</div>
                <div>Current Turn: {unifiedPipeline.current?.getCurrentTurnId() || "None"}</div>
                <div>Turns: {turns.length}</div>
                <div>Mic Track: {micTrack?.id || "None"}</div>
                <div>Published Track: {publishedTrackId || "None"}</div>
              </div>
            </div>

            {/* Debug Overlay */}
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
              <h3 className="text-sm font-medium text-blue-900 mb-2">Debug Overlay</h3>
              <div className="text-sm text-blue-800 space-y-1">
                <div>Last ASR: {lastASRText || "None"}</div>
                <div>Mute State: {currentMuteState ? "Muted" : "Unmuted"}</div>
                
                {/* Centralized Audio Debug Info */}
                {audioDebugInfo && (
                  <>
                    <div className="mt-2 pt-2 border-t border-blue-300">
                      <div className="font-medium text-blue-900">Audio Pipeline Status:</div>
                      <div>Mic: {audioDebugInfo.micReady ? "ready" : "not-ready"}</div>
                      <div>Mic RMS: {audioDebugInfo.micRMS.toFixed(3)}</div>
                      <div>TTS: {audioDebugInfo.ttsPlaying ? "playing" : "idle"}</div>
                      <div>Barge-in: {audioDebugInfo.bargeInMonitoring ? "active" : "inactive"}</div>
                      <div>Speech: {audioDebugInfo.speechActive ? "active" : "inactive"}</div>
                      <div>AudioContext: {audioDebugInfo.audioContextState}</div>
                    </div>
                    
                    <div className="mt-2 pt-2 border-t border-blue-300">
                      <div className="font-medium text-blue-900">Dev HUD:</div>
                      <div>Dispatcher: {isMuted() ? "muted" : "unmuted"}</div>
                      <div>Room: {livekitRoom.current?.state === 'connected' ? "connected" : "not"}</div>
                      <div>Mic Track: {audioDebugInfo.micTrackId}</div>
                      <div>Analyzers: Mic={audioDebugInfo.micAnalyzerReady ? "✓" : "✗"}, AI={audioDebugInfo.aiAnalyzerReady ? "✓" : "✗"}</div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

export default function SessionPage() {
  return (
    <ClientOnly>
      <Suspense fallback={<div>Loading...</div>}>
        <SessionInner />
      </Suspense>
    </ClientOnly>
  );
}


