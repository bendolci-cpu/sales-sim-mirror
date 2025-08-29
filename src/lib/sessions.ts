export type SavedSession = {
  id: string;
  ts: number;
  mode: "challenge" | "practice" | "clean";
  scenarioId: string;
  scenarioTitle: string;
  callPoint: string;
  topic: string;
  url: string;
};

const STORAGE_KEY = "sales-sim:sessions";

function readRaw(): SavedSession[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedSession[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(s => s && typeof s.id === "string")
      .sort((a, b) => b.ts - a.ts);
  } catch {
    return [];
  }
}

export function getSessions(): SavedSession[] {
  return readRaw();
}

export function addSession(session: SavedSession): void {
  if (typeof window === "undefined") return;
  const current = readRaw();
  const next = [session, ...current].slice(0, 10);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function clearSessions(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}

export function removeSession(id: string): void {
  if (typeof window === "undefined") return;
  const current = readRaw();
  const next = current.filter(s => s.id !== id);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}


