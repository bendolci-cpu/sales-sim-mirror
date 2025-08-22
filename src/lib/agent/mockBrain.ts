import type { Scenario } from "@/data/scenarios";

function includesAny(text: string, words: string[]) {
  const t = text.toLowerCase();
  return words.some(w => t.includes(w));
}

export function generateReply({ userText, scenario }: { userText: string; scenario: { topic: string; brief: string; objectionBank?: string[] } }): string {
  const t = (userText || "").toLowerCase();
  if (includesAny(t, ["price", "budget"])) {
    return `Let’s tie this to outcomes in ${scenario.topic}—we focus on ROI, not just unit cost.`;
  }
  if (includesAny(t, ["bleach", "residue", "compatible", "compatibility"])) {
    return `We support compatibility with clear contact times; residue is managed with proper technique.`;
  }
  // first-turn discovery style (no randomness—derive from brief)
  if (t.length < 4) {
    const first = scenario.brief.split(".")[0];
    return `${first}?`;
  }
  const ob = (scenario.objectionBank && scenario.objectionBank[0]) || "Let’s align on your top priority.";
  return `${ob}`;
}


