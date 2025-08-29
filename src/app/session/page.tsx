"use client";

import React, { useRef, useState, useEffect, Suspense } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import ClientOnly from "@/components/ClientOnly";
const ChatWindowClient = dynamic(() => import("@/components/ChatWindow"), { ssr: false });
import BudgetBadge from "@/components/BudgetBadge";
import ScenarioPicker from "@/components/ScenarioPicker";
import { SCENARIOS, type Scenario } from "@/data/scenarios";
import { getAgentReply } from "@/lib/voice/mockAgent";
import CallBar from "@/components/CallBar";
import DebugToggle from "@/components/DebugToggle";
import AudioDeviceSelector from "@/components/AudioDeviceSelector";
import { saveCall } from "@/lib/calls/store";
import type { CallMeta, CallTurn } from "@/lib/calls/types";
import { logInfo, logWarn, logError } from "@/lib/logger";
import { registerMessageHandler, unregisterMessageHandler, setMessageDispatcherConnected } from "@/lib/messageDispatcher";
import { getUnifiedAudioPipeline, cleanupUnifiedAudioPipeline } from "@/lib/unifiedAudioPipeline";

// Audio pipeline constants
const MIC_RMS_SPEECH = 55;
const AI_RMS_GATE = 20;
const MIN_UTTERANCE_MS = 600;

interface Turn {
  id: string;
  role: "user" | "assistant";
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
  
  // Refs
  const unifiedPipeline = useRef(getUnifiedAudioPipeline());
  const scenario = SCENARIOS.find(s => s.id === scenarioId);
  
  // === MESSAGE DISPATCHER HANDLER ===
  
  const handleMessageDispatcher = async (request: any) => {
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
        aiResponse = data.response;
        logInfo(`[Session] Generated live response: ${aiResponse}`);
      }
      
      // Add AI turn
      const aiTurn: Turn = {
        id: crypto.randomUUID(),
        role: "assistant",
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
      if (voiceConnected && !isMock) {
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
      logInfo("[Session] Initializing unified pipeline...");
      await unifiedPipeline.current.initialize();
      logInfo("[Session] Unified pipeline initialized successfully");
      
      // Get mic stream for UI
      const stream = unifiedPipeline.current.getMicStream();
      setMicStream(stream);
      
      // Connect message dispatcher
      logInfo("[Session] Connecting message dispatcher...");
      setMessageDispatcherConnected(true);
      
      setVoiceConnected(true);
      logInfo("[Session] Call started successfully");
      
      // Play greeting if available
      if (scenario?.greeting) {
        logInfo(`[Session] Playing greeting: "${scenario.greeting}"`);
        const greetingTurn: Turn = {
          id: crypto.randomUUID(),
          role: "assistant",
          text: scenario.greeting,
          timestamp: Date.now()
        };
        setTurns([greetingTurn]);
        setExternalTurn({
          role: "bot",
          text: scenario.greeting,
          timestamp: greetingTurn.timestamp
        });
        
        if (!isMock) {
          try {
            logInfo("[Session] Starting TTS for greeting...");
            await unifiedPipeline.current.playTTS(scenario.greeting, greetingTurn.id);
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
  
  const handleEnd = () => {
    if (!voiceConnected) return;
    
    logInfo("[Session] Ending call");
    
    // Disconnect message dispatcher
    setMessageDispatcherConnected(false);
    
    // Cleanup unified pipeline
    cleanupUnifiedAudioPipeline();
    
    setVoiceConnected(false);
    setMicStream(null);
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
    handleMessageDispatcher({ text, metadata: { source: "chat" } });
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
                {scenario.name} • {mode} • {isMock ? "Mock" : "Live"} • {voiceConnected ? "Connected" : "Disconnected"}
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
                  setIsMock(newMockValue);
                  
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
            <ScenarioPicker />
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
            {voiceConnected && (
              <div className="rounded-lg border border-green-200 bg-green-50 p-4">
                <h3 className="text-sm font-medium text-green-900 mb-2">Pipeline Status</h3>
                <div className="text-sm text-green-800 space-y-1">
                  <div>TTS: {unifiedPipeline.current.isTTSPlaying() ? "Playing" : "Idle"}</div>
                  <div>Current Turn: {unifiedPipeline.current.getCurrentTurnId() || "None"}</div>
                  <div>Turns: {turns.length}</div>
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


