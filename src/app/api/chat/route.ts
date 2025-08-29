import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { messages, scenario } = body;

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: "messages array is required" }, { status: 400 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.warn("OPENAI_API_KEY not configured, returning fallback response");
      return NextResponse.json({ 
        content: "I'm here to help with your sales training. How can I assist you today?",
        fallback: true
      });
    }

    // Build system message based on scenario
    let systemMessage = "You are a helpful sales training assistant. Keep responses concise and natural for voice conversation. Respond in 1-2 sentences maximum.";
    
    if (scenario) {
      systemMessage += `\n\nCurrent scenario: ${scenario.topic || 'Sales Training'}`;
      if (scenario.persona) {
        systemMessage += `\nYou are role-playing as: ${scenario.persona}`;
      }
      if (scenario.brief) {
        systemMessage += `\nScenario context: ${scenario.brief}`;
      }
    }

    // Prepare messages for OpenAI
    const openaiMessages = [
      { role: "system", content: systemMessage },
      ...messages.map((msg: any) => ({
        role: msg.role === "user" ? "user" : "assistant",
        content: msg.text || msg.content
      }))
    ];

    console.log("[Chat] Generating response for messages:", openaiMessages.length);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: openaiMessages,
      max_tokens: 100,
      temperature: 0.7,
      stream: false,
    });

    const response = completion.choices[0]?.message?.content || "I didn't catch that. Could you please repeat?";

    // Track usage for budget
    if (completion.usage) {
      try {
        await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/api/budget/track`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            usage: completion.usage
          })
        });
      } catch (e) {
        console.warn('Failed to track budget usage:', e);
      }
    }

    return NextResponse.json({ 
      content: response,
      usage: completion.usage
    });
  } catch (error) {
    console.error("Chat completion error:", error);
    return NextResponse.json({ 
      error: "Chat completion failed",
      details: error instanceof Error ? error.message : String(error)
    }, { status: 500 });
  }
}
