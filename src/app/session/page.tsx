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
import { registerMessageHandler, unregisterMessageHandler, setMessageDispatcherConnected } from "@/lib/messageDispatcher";
import { getUnifiedAudioPipeline, cleanupUnifiedAudioPipeline } from "@/lib/unifiedAudioPipeline";
import { Room, createLocalAudioTrack } from "livekit-client";
import type { MessageRequest, MessageResponse } from "@/lib/messageDispatcher";

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
  
  // Refs
  const unifiedPipeline = useRef<ReturnType<typeof getUnifiedAudioPipeline> | null>(null);
  const livekitRoom = useRef<Room | null>(null);
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
        },
        onTTSStart: (turnId) => {
          logInfo(`[Session] TTS started for turn: ${turnId}`);
        },
        onTTSEnd: (turnId) => {
          logInfo(`[Session] TTS ended for turn: ${turnId}`);
          // Don't auto-end the call - keep it connected
        },
        onTTSError: (error) => {
          logError('[Session] TTS error:', error);
        }
      });
    }
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
          await unifiedPipeline.current.playTTS(aiResponse, aiTurn.id);
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
    
    try {
      // Initialize unified pipeline
      if (!unifiedPipeline.current) {
        throw new Error("Pipeline not initialized");
      }
      logInfo("[Session] Initializing unified pipeline...");
      await unifiedPipeline.current.initialize();
      logInfo("[Session] Unified pipeline initialized successfully");
      
      // Get mic stream for UI
      const stream = unifiedPipeline.current.getMicStream();
      setMicStream(stream);
      
      // Connect to LiveKit if not in mock mode
      if (!isMock) {
        await connectToLiveKit();
      }
      
      // Connect message dispatcher
      logInfo("[Session] Connecting message dispatcher...");
      setMessageDispatcherConnected(true);
      
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
            await unifiedPipeline.current.playTTS(greeting, greetingTurn.id);
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
  
  const connectToLiveKit = async () => {
    if (!micTrack) {
      logError("[Session] No mic track available for LiveKit");
      return;
    }
    
    try {
      // Create LiveKit room
      livekitRoom.current = new Room();
      
      // Connect to room (you'll need to configure the room URL)
      const roomUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL || 'wss://your-livekit-server.com';
      const token = 'your-token'; // You'll need to implement token generation
      
      await livekitRoom.current.connect(roomUrl, token);
      
      // Create local audio track from our mic stream
      const localTrack = await createLocalAudioTrack();
      
      // Publish the track
      await livekitRoom.current.localParticipant.publishTrack(localTrack);
      
      if (localTrack.sid) {
        setPublishedTrackId(localTrack.sid);
        logInfo(`[Session] Published track: ${localTrack.sid}`);
        
        // Log track IDs for debugging
        logInfo(`[Mic/Publish] ids {micTrackId: ${micTrack.id}, publishedTrackId: ${localTrack.sid}, equal: ${micTrack.id === localTrack.sid}}`);
      }
      
      logInfo("[Session] Connected to LiveKit room");
    } catch (error) {
      logError("[Session] Failed to connect to LiveKit:", error);
    }
  };
  
  const handleEnd = () => {
    if (!voiceConnected) return;
    
    logInfo("[Session] Ending call");
    
    // Disconnect from LiveKit
    if (livekitRoom.current) {
      livekitRoom.current.disconnect();
      livekitRoom.current = null;
    }
    
    // Disconnect message dispatcher
    setMessageDispatcherConnected(false);
    
    // Cleanup unified pipeline
    cleanupUnifiedAudioPipeline();
    
    setVoiceConnected(false);
    setMicStream(null);
    setMicTrack(null);
    setPublishedTrackId(null);
    setTurns([]);
    setExternalTurn(null);
    logInfo("[Session] Call ended");
  };
  
  // === CHAT HANDLERS ===
  
  const handleChatUserUtterance = (text: string) => {
    if (!voiceConnected) return;
    
    logInfo(`[Session] Chat user utterance: "${text}"`);
    
    // Add user turn
    const userTurn: Turn = {
      id: crypto.randomUUID(),
      role: "user",
      text,
      timestamp: Date.now()
    };
    setTurns(prev => [...prev, userTurn]);
    setExternalTurn({
      role: "user",
      text,
      timestamp: userTurn.timestamp
    });
    
    // Process through message dispatcher
    handleMessageDispatcher({
      text,
      metadata: { 
        source: "text",
        timestamp: Date.now()
      }
    });
  };
  
  // === LIFECYCLE ===
  
  useEffect(() => {
    // Register message handler
    registerMessageHandler(handleMessageDispatcher);
    
    return () => {
      // Unregister message handler
      unregisterMessageHandler(handleMessageDispatcher);
      
      // Cleanup pipeline
      cleanupUnifiedAudioPipeline();
    };
  }, [turns]); // Include turns in dependency to access latest state
  
  // === RENDER ===
  
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
                {scenario.title} • {mode} • {isMock ? "Mock" : "Live"} • {voiceConnected ? "Connected" : "Disconnected"}
              </p>
            </div>
            
            <div className="flex items-center gap-4">
              <BudgetBadge />
              <DebugToggle />
              
              {/* Mock/Live Toggle */}
              <button
                onClick={async () => {
                  if (isToggling) return;
                  setIsToggling(true);
                  
                  const newMockValue = !isMock;
                  
                  // Update URL to persist the change
                  const params = new URLSearchParams(searchParams.toString());
                  params.set("mock", newMockValue ? "1" : "0");
                  router.replace(`${pathname}?${params.toString()}`, { scroll: false });
                  
                  logInfo(`[Session] Switching from ${isMock ? 'mock' : 'live'} to ${newMockValue ? 'mock' : 'live'} mode`);
                  setIsToggling(false);
                }}
                disabled={isToggling}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  isToggling
                    ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                    : isMock
                    ? "bg-blue-100 text-blue-700 hover:bg-blue-200"
                    : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                }`}
              >
                {isToggling ? "Switching..." : `Mock: ${isMock ? "On" : "Off"}`}
              </button>
            </div>
          </div>
          
          {/* Scenario Picker */}
          <div className="mb-6">
            <ScenarioPicker onChange={() => {}} />
          </div>

          <div className="flex flex-col gap-6">
            <CallBar
              state={voiceConnected ? "connected" : "idle"}
              onCall={handleCall}
              onEnd={handleEnd}
              stream={micStream}
              isInitializing={isInitializing}
            />

            {showChat && (
              <div className="rounded-lg border border-gray-200 bg-white p-4">
                <ChatWindowClient
                  visible={showChat}
                  isMock={isMock}
                  voiceConnected={voiceConnected}
                  callActive={voiceConnected}
                  externalTurn={externalTurn}
                  onUserUtterance={handleChatUserUtterance}
                />
              </div>
            )}

            {/* Audio Device Settings */}
            {showChat && (
              <AudioDeviceSelector />
            )}

            {/* Pipeline Status */}
            {voiceConnected && unifiedPipeline.current && (
              <div className="rounded-lg border border-green-200 bg-green-50 p-4">
                <h3 className="text-sm font-medium text-green-900 mb-2">Pipeline Status</h3>
                <div className="text-sm text-green-800 space-y-1">
                  <div>TTS: {unifiedPipeline.current.isTTSPlaying() ? "Playing" : "Idle"}</div>
                  <div>Current Turn: {unifiedPipeline.current.getCurrentTurnId() || "None"}</div>
                  <div>Turns: {turns.length}</div>
                  <div>Mic Track: {micTrack?.id || "None"}</div>
                  <div>Published Track: {publishedTrackId || "None"}</div>
                </div>
              </div>
            )}
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


