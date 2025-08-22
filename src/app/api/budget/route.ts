import { NextResponse } from "next/server";
import { getBudgetState } from "@/server/billing/budget";

export async function GET() {
  const st = getBudgetState();
  const hasKey = Boolean(process.env.OPENAI_API_KEY);
  const json = {
    usage: st.spentUsd,
    remaining: st.remainingUsd,
    allowed: st.allowed,
    hasKey,
    budgetOk: st.allowed,
    max: st.maxUsd,
  };
  return NextResponse.json(json);
}


