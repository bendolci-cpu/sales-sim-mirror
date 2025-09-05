// MOCK MODE DISABLED - This file is kept for future reference
// To re-enable mock mode:
// 1. Import this file in session/page.tsx
// 2. Add isMock state and toggle UI
// 3. Add conditional logic to use getAgentReply() instead of /api/chat

import type { Scenario } from "@/data/scenarios";

export type HistoryTurn = { role: "user" | "agent"; text: string };

export function getAgentReply(history: HistoryTurn[], scenario: Scenario): string {
  const lastUser = [...history].reverse().find(h => h.role === "user")?.text.toLowerCase() || "";
  const topic = scenario.topic.toLowerCase();
  const canned: string[] = [];
  if (topic.includes("sporicid")) {
    canned.push("We’ve seen strong outcomes when teams adopt a consistent sporicidal protocol.");
    canned.push("Can you share how your staff currently handles C. diff room turnovers?");
  } else if (topic.includes("bundle")) {
    canned.push("Happy to talk renewal. Which areas have delivered the most value for you?");
    canned.push("We can streamline the bundle so it matches your current priorities.");
  } else {
    canned.push("I’m listening. What’s top of mind today?");
    canned.push("Tell me more about your current process—where are the bottlenecks?");
  }

  if (lastUser.includes("price") || lastUser.includes("cost")) {
    return "Totally fair—let’s anchor on outcomes first, then we’ll size the investment.";
  }
  if (lastUser.includes("time") || lastUser.includes("staff")) {
    return "Understood. We focus on reducing staff friction with clear, fast workflows.";
  }
  if (lastUser.includes("no") || lastUser.includes("not now")) {
    return "Sure—if now’s not ideal, what would make the timing right?";
  }
  return canned[Math.floor(Math.random() * canned.length)];
}

export function speak(text: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return resolve();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "en-US";
    utter.rate = 1;
    const selectVoice = () => {
      const voices = window.speechSynthesis.getVoices();
      const voice = voices.find(v => v.lang.startsWith("en-US")) || voices.find(v => v.lang.startsWith("en"));
      if (voice) utter.voice = voice;
    };
    selectVoice();
    if ((window.speechSynthesis.getVoices() || []).length === 0) {
      try { window.speechSynthesis.onvoiceschanged = selectVoice; } catch {}
    }
    const onAbort = () => { try { window.speechSynthesis.cancel(); } catch {}; cleanup(); resolve(); };
    const cleanup = () => { if (signal) signal.removeEventListener("abort", onAbort); };
    if (signal) signal.addEventListener("abort", onAbort);
    utter.onend = () => { cleanup(); resolve(); };
    utter.onerror = () => { cleanup(); resolve(); };
    window.speechSynthesis.speak(utter);
  });
}

export function stopSpeaking() {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  try { window.speechSynthesis.cancel(); } catch {}
}


