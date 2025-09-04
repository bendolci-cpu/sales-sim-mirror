"use client";

import React, { FormEvent, useEffect, useRef, useState } from "react";
import MicRecorder from "@/components/MicRecorder";
import { SpeechManager } from "@/lib/voice/SpeechManager";
import { logInfo } from "@/lib/logger";
import { sendMessage } from "@/lib/messageDispatcher";

type Message = {
  id: number;
  sender: "user" | "bot";
  text: string;
  timestamp: number;
};

const initialMessages: Message[] = [
  { id: 1, sender: "bot", text: "Welcome to Sales Sim!", timestamp: Date.now() - 1000 * 60 * 5 },
  { id: 2, sender: "user", text: "Hey there 👋", timestamp: Date.now() - 1000 * 60 * 4 },
  { id: 3, sender: "bot", text: "How can I help you today?", timestamp: Date.now() - 1000 * 60 * 3 },
];

export type ChatWindowProps = {
  visible?: boolean;
  isMock?: boolean;
  seedMessages?: string[];
  voiceConnected?: boolean; // legacy
  callActive?: boolean;
  onUserUtterance?: (text: string) => void;
  externalTurn?: { role: "user" | "bot"; text: string; timestamp?: number } | null;
};

export default function ChatWindow({ visible = true, isMock = true, seedMessages, voiceConnected = false, callActive = false, onUserUtterance, externalTurn }: ChatWindowProps) {
  if (!visible) return null;
  const seeded = useRef<boolean>(false);
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [inputValue, setInputValue] = useState("");
  const nextIdRef = useRef<number>(initialMessages[initialMessages.length - 1]?.id + 1 || 1);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastExternalHashRef = useRef<string>("");
  const [interim, setInterim] = useState<string>("");

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length]);

  useEffect(() => {
    if (!isMock) {
      // Clear seeded messages when switching to live
      seeded.current = false;
      setMessages([]);
      return;
    }
    if (seeded.current) return;
    if (seedMessages && seedMessages.length > 0) {
      const seeds: Message[] = seedMessages.map(text => ({
        id: nextIdRef.current++,
        sender: "bot",
        text,
        timestamp: Date.now(),
      }));
      setMessages(seeds);
      seeded.current = true;
    }
  }, [seedMessages, isMock]);

  // Append externally-driven turn (from call flow), with simple adjacent de-dupe
  useEffect(() => {
    if (!externalTurn) return;
    const text = (externalTurn.text || "").trim();
    if (!text) return;
    const hash = `${externalTurn.role}|${text}`;
    if (hash === lastExternalHashRef.current) return;
    setMessages(prev => {
      const last = prev[prev.length - 1];
      const lastHash = last ? `${last.sender}|${(last.text || "").trim()}` : "";
      if (lastHash === hash) return prev; // dedupe
      const msg: Message = {
        id: nextIdRef.current++,
        sender: externalTurn.role === "user" ? "user" : "bot",
        text,
        timestamp: externalTurn.timestamp ?? Date.now(),
      };
      return [...prev, msg];
    });
    lastExternalHashRef.current = hash;
  }, [externalTurn]);

  useEffect(() => {
    if (!callActive) return;
    const offRes = SpeechManager.onResult(({ interim, final }) => {
      if (interim) setInterim(interim);
      if (final) {
        setInterim("");
        // Push as user message locally (ChatWindow maintains its own debug list)
        const userMessage: Message = { id: nextIdRef.current++, sender: "user", text: final, timestamp: Date.now() };
        setMessages(prev => [...prev, userMessage]);
        onUserUtterance?.(final);
      }
    });
    const offStatus = SpeechManager.onStatus((s) => {
      // no-op; could reflect status in UI if needed
    });
    return () => { offRes(); offStatus(); };
  }, [callActive, onUserUtterance]);

  function handleSend(event: FormEvent) {
    event.preventDefault();
    const text = inputValue.trim();
    if (!text) return;

    const userMessage: Message = {
      id: nextIdRef.current++,
      sender: "user",
      text,
      timestamp: Date.now(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInputValue("");

    if (isMock) {
      setTimeout(() => {
        const botMessage: Message = {
          id: nextIdRef.current++,
          sender: "bot",
          text: "Got it! (fake reply)",
          timestamp: Date.now(),
        };
        setMessages(prev => [...prev, botMessage]);
      }, 1000);
    } else {
      // In live mode, use the message dispatcher for consistency
      sendMessage(text, {
        source: 'text'
      }).catch(error => {
        logInfo('[ChatWindow] Failed to send message to dispatcher, falling back to onUserUtterance', { error });
        onUserUtterance?.(text);
      });
    }
  }

  // Allow external call flow to submit user utterances
  useEffect(() => {
    if (!onUserUtterance) return;
  }, [onUserUtterance]);

  return (
    <div className="flex w-full max-w-xl flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold text-gray-900">Chat</h2>
      </div>

      {isMock ? (
        <>
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {messages.map(message => (
              <div key={message.id} className={`flex ${message.sender === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`inline-block max-w-[80%] rounded-2xl px-4 py-2 text-sm ${
                    message.sender === "user"
                      ? "bg-blue-600 text-white"
                      : "bg-gray-100 text-gray-900"
                  }`}
                >
                  {message.text}
                </div>
              </div>
            ))}
          </div>

          <form onSubmit={handleSend} className="border-t px-3 py-2">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={inputValue}
                onChange={e => setInputValue(e.target.value)}
                placeholder="Type your message..."
                className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {!callActive && !voiceConnected && (
                <MicRecorder
                  onTextPartial={async (t) => {
                    setInputValue(t);
                  }}
                  onTextFinal={async (t) => {
                    setInputValue(t);
                  }}
                />
              )}
              <button
                type="submit"
                disabled={!inputValue.trim()}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                Send
              </button>
            </div>
            {callActive && (
              <p className="mt-1 pl-1 text-[11px] text-gray-500">Voice capture is on—speak naturally.{interim ? ` — ${interim}` : ""}</p>
            )}
          </form>
        </>
      ) : (
        <>
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {messages.map(message => (
              <div key={message.id} className={`flex ${message.sender === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`inline-block max-w-[80%] rounded-2xl px-4 py-2 text-sm ${
                    message.sender === "user"
                      ? "bg-blue-600 text-white"
                      : "bg-gray-100 text-gray-900"
                  }`}
                >
                  {message.text}
                </div>
              </div>
            ))}
          </div>

          <form onSubmit={handleSend} className="border-t px-3 py-2">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={inputValue}
                onChange={e => setInputValue(e.target.value)}
                placeholder="Type your message..."
                className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {!callActive && !voiceConnected && (
                <MicRecorder
                  onTextPartial={async (t) => {
                    setInputValue(t);
                  }}
                  onTextFinal={async (t) => {
                    setInputValue(t);
                  }}
                />
              )}
              <button
                type="submit"
                disabled={!inputValue.trim()}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                Send
              </button>
            </div>
            {callActive && (
              <p className="mt-1 pl-1 text-[11px] text-gray-500">Voice capture is on—speak naturally.{interim ? ` — ${interim}` : ""}</p>
            )}
          </form>
        </>
      )}
    </div>
  );
}


