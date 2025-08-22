import fs from "fs";
import path from "path";

export const MAX_BUDGET_USD: number = Number(process.env.MAX_BUDGET_USD ?? 100);

export type BudgetFile = {
  month: string;
  spentUsd: number;
};

const USAGE_FILE_PATH = path.join(process.cwd(), ".local-usage.json");

function getCurrentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function readFileSafe(): BudgetFile | null {
  try {
    if (!fs.existsSync(USAGE_FILE_PATH)) return null;
    const raw = fs.readFileSync(USAGE_FILE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as BudgetFile;
    if (!parsed || typeof parsed.month !== "string" || typeof parsed.spentUsd !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeFileSafe(data: BudgetFile): void {
  try {
    fs.writeFileSync(USAGE_FILE_PATH, JSON.stringify(data, null, 2), "utf-8");
  } catch {
    // ignore disk write issues in local dev
  }
}

function ensureState(): BudgetFile {
  const month = getCurrentMonth();
  const existing = readFileSafe();
  if (!existing) {
    const fresh: BudgetFile = { month, spentUsd: 0 };
    writeFileSafe(fresh);
    return fresh;
  }
  if (existing.month !== month) {
    const reset: BudgetFile = { month, spentUsd: 0 };
    writeFileSafe(reset);
    return reset;
  }
  return existing;
}

export type BudgetState = {
  month: string;
  spentUsd: number;
  remainingUsd: number;
  maxUsd: number;
  allowed: boolean;
};

export function getBudgetState(): BudgetState {
  const st = ensureState();
  const remaining = Math.max(0, MAX_BUDGET_USD - st.spentUsd);
  return {
    month: st.month,
    spentUsd: st.spentUsd,
    remainingUsd: remaining,
    maxUsd: MAX_BUDGET_USD,
    allowed: remaining > 0,
  };
}

export function addSpend(amountUsd: number): void {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return;
  const st = ensureState();
  const next: BudgetFile = { month: st.month, spentUsd: st.spentUsd + amountUsd };
  writeFileSafe(next);
}


