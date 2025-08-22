"use client";

import React, { FormEvent, useEffect, useRef, useState } from "react";
import MicRecorder from "@/components/MicRecorder";

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
  isMock?: boolean;
  seedMessages?: string[];
  voiceConnected?: boolean;
  onUserUtterance?: (text: string) => void;
};

export default function ChatWindow({ isMock = true, seedMessages, voiceConnected = false, onUserUtterance }: ChatWindowProps) {
  const seeded = useRef<boolean>(false);
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [inputValue, setInputValue] = useState("");
  const nextIdRef = useRef<number>(initialMessages[initialMessages.length - 1]?.id + 1 || 1);
  const scrollRef = useRef<HTMLDivElement | null>(null);

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
              {!voiceConnected && (
                <MicRecorder
                  onTextPartial={(t) => setInputValue(t)}
                  onTextFinal={(t) => {
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
          </form>
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center px-4 py-8 text-sm text-gray-600">
          Live mode not yet implemented.
        </div>
      )}
    </div>
  );
}


