import { NextRequest, NextResponse } from "next/server";
import { recordUsage } from "@/server/billing/budget";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { model, usage } = body;

    if (!model || !usage) {
      return NextResponse.json({ error: "Missing model or usage data" }, { status: 400 });
    }

    // Record the usage
    await recordUsage({
      model,
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || 0,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Budget tracking error:", error);
    return NextResponse.json({ error: "Failed to track usage" }, { status: 500 });
  }
}
