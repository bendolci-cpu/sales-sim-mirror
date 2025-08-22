import { addSpend, getBudgetState } from "./budget";

type OpenAIClient = unknown; // Placeholder type to avoid adding SDK dependency now

export function getOpenAI(): OpenAIClient {
  const st = getBudgetState();
  if (!st.allowed) {
    throw new Error("Budget cap reached. OpenAI calls are disabled.");
  }
  // In the future, instantiate the SDK here and return it
  return {} as OpenAIClient;
}

export function recordOpenAISpendFromUsage(usage: any): void {
  // Try to derive cost from token usage if provided; fallback to a tiny estimate
  try {
    if (usage && typeof usage === "object") {
      // Heuristic: $0.000002 per token if totals exist (purely placeholder)
      const totalTokens = Number(usage.total_tokens ?? usage.totalTokens ?? 0);
      if (Number.isFinite(totalTokens) && totalTokens > 0) {
        addSpend(totalTokens * 0.000002);
        return;
      }
    }
  } catch {}
  // Fallback minimal spend to account for unknown usage
  addSpend(0.0005);
}


