import type { CallMeta } from "./types";

const PREFIX = "calls:";

export function saveCall(meta: CallMeta): void {
  try { localStorage.setItem(PREFIX + meta.id, JSON.stringify(meta)); } catch {}
}

export function loadCall(id: string): CallMeta | null {
  try {
    const raw = localStorage.getItem(PREFIX + id);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function updateCall(id: string, partial: Partial<CallMeta>): CallMeta | null {
  const cur = loadCall(id);
  if (!cur) return null;
  const next = { ...cur, ...partial } as CallMeta;
  saveCall(next);
  return next;
}

export function listCalls(): CallMeta[] {
  try {
    const items: CallMeta[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i) || "";
      if (!key.startsWith(PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try { items.push(JSON.parse(raw)); } catch {}
    }
    return items.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  } catch { return []; }
}


