"use client";

import React, { useRef, useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { logInfo, logDebug, logWarn, logError } from "@/lib/logger";
import { registerMessageHandler, unregisterMessageHandler, setMessageDispatcherConnected } from "@/lib/messageDispatcher";
import { getUnifiedAudioPipeline, cleanupUnifiedAudioPipeline } from "@/lib/unifiedAudioPipeline";
import { getAgentReply, speak as agentSpeak } from "@/lib/voice/mockAgent";
import { SCENARIOS, type Scenario } from "@/data/scenarios";
import CallBar from "@/components/CallBar";
import ChatWindow from "@/components/ChatWindow";

interface Turn {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

export default function CleanSessionPage() {
  const searchParams = useSearchParams();
  const mode = searchParams.get("mode") || "practice";
  const mock = searchParams.get("mock") === "1";
  const scenarioId = searchParams.get("scenario") || "cdi-outbreak-icu";
  
  const [isConnected, setIsConnected] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  
  const scenario = SCENARIOS.find(s => s.id === scenarioId);
  const unifiedPipeline = useRef(getUnifiedAudioPipeline());
  
  // Fallback scenario if not found
  const fallbackScenario = SCENARIOS[0]; // Use first scenario as fallback
  
  // Debug logging
  console.log("[CleanSession] Component rendered with:", {
    mode,
    mock,
    scenarioId,
    scenario: scenario?.name,
    scenarioTitle: scenario?.title,
    isConnected,
    turnsCount: turns.length,
    availableScenarios: SCENARIOS.map(s => s.id)
  });
  
  // === MESSAGE DISPATCHER HANDLER ===
  
  const handleMessageDispatcher = async (request: any) => {
    const { text, metadata } = request;
    const turnId = crypto.randomUUID();
    
    logInfo(`[CleanSession] Processing message: "${text}" (${metadata.source})`);
    
    // Add user turn
    const userTurn: Turn = {
      id: turnId,
      role: "user",
      text,
      timestamp: Date.now()
    };
    setTurns(prev => [...prev, userTurn]);
    
    // Generate AI response
    setIsLoading(true);
    try {
      let aiResponse: string;
      
      if (mock) {
        const scenarioToUse = scenario || fallbackScenario;
        aiResponse = getAgentReply([...turns, userTurn], scenarioToUse);
        logInfo(`[CleanSession] Generated mock response: ${aiResponse}`);
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
        logInfo(`[CleanSession] Generated live response: ${aiResponse}`);
      }
      
      // Add AI turn
      const aiTurn: Turn = {
        id: crypto.randomUUID(),
        role: "assistant",
        text: aiResponse,
        timestamp: Date.now()
      };
      setTurns(prev => [...prev, aiTurn]);
      
      // Play TTS if connected
      if (isConnected && !mock) {
        try {
          await unifiedPipeline.current.playTTS(aiResponse, aiTurn.id);
        } catch (error) {
          logError(`[CleanSession] TTS failed for turn ${aiTurn.id}:`, error);
        }
      }
      
      // Return success response
      return {
        id: turnId,
        text: aiResponse,
        success: true
      };
      
    } catch (error) {
      logError(`[CleanSession] Failed to generate AI response:`, error);
      return {
        id: turnId,
        text: '',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    } finally {
      setIsLoading(false);
    }
  };
  
  // === CALL MANAGEMENT ===
  
  const startCall = async () => {
    logInfo("[CleanSession] Starting call");
    
    try {
      // Initialize unified pipeline
      logInfo("[CleanSession] Initializing unified pipeline...");
      await unifiedPipeline.current.initialize();
      logInfo("[CleanSession] Unified pipeline initialized successfully");
      
      // Connect message dispatcher
      logInfo("[CleanSession] Connecting message dispatcher...");
      setMessageDispatcherConnected(true);
      
      setIsConnected(true);
      logInfo("[CleanSession] Call started successfully");
      
      // Play greeting if available
      if (scenario?.greeting) {
        logInfo(`[CleanSession] Playing greeting: "${scenario.greeting}"`);
        const greetingTurn: Turn = {
          id: crypto.randomUUID(),
          role: "assistant",
          text: scenario.greeting,
          timestamp: Date.now()
        };
        setTurns([greetingTurn]);
        
        if (!mock) {
          try {
            logInfo("[CleanSession] Starting TTS for greeting...");
            await unifiedPipeline.current.playTTS(scenario.greeting, greetingTurn.id);
            logInfo("[CleanSession] Greeting TTS completed");
          } catch (error) {
            logError(`[CleanSession] Greeting TTS failed:`, error);
          }
        } else {
          logInfo("[CleanSession] Mock mode - skipping TTS");
        }
      } else {
        logInfo("[CleanSession] No greeting available");
      }
      
    } catch (error) {
      logError("[CleanSession] Failed to start call:", error);
    }
  };
  
  const endCall = () => {
    logInfo("[CleanSession] Ending call");
    
    // Disconnect message dispatcher
    setMessageDispatcherConnected(false);
    
    // Cleanup unified pipeline
    cleanupUnifiedAudioPipeline();
    
    setIsConnected(false);
    setTurns([]);
    logInfo("[CleanSession] Call ended");
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
    <div className="flex h-screen flex-col">
      {/* Header */}
      <div className="border-b bg-white p-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">Clean Session</h1>
            <p className="text-sm text-gray-600">
              {scenario.name} • {mock ? "Mock" : "Live"} • {isConnected ? "Connected" : "Disconnected"}
            </p>
          </div>
          
          <CallBar
            state={isConnected ? "connected" : "idle"}
            onCall={startCall}
            onEnd={endCall}
            isInitializing={isLoading}
            stream={unifiedPipeline.current.getMicStream()}
          />
        </div>
      </div>
      
      {/* Chat Window */}
      <div className="flex-1 overflow-hidden">
        <ChatWindow
          visible={true}
          isMock={mock}
          callActive={isConnected}
          externalTurn={turns.length > 0 ? {
            role: turns[turns.length - 1].role === "assistant" ? "bot" : "user",
            text: turns[turns.length - 1].text,
            timestamp: turns[turns.length - 1].timestamp
          } : null}
        />
      </div>
      
      {/* Debug Info */}
      <div className="border-t bg-gray-50 p-2 text-xs text-gray-600">
        <div>Pipeline: {unifiedPipeline.current.isTTSPlaying() ? "TTS Playing" : "Idle"}</div>
        <div>Turns: {turns.length}</div>
        <div>Current Turn: {unifiedPipeline.current.getCurrentTurnId() || "None"}</div>
        <div>Scenario: {scenario.name}</div>
        <div>Mode: {mode}</div>
        <div>Mock: {mock ? "Yes" : "No"}</div>
        <div>Connected: {isConnected ? "Yes" : "No"}</div>
      </div>
    </div>
  );
}
