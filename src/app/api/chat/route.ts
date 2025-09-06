import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { info, error } from "@/lib/logger";

export const runtime = "nodejs";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

interface ChatMessage {
  role: string;
  text?: string;
  content?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { messages } = body;

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json(
        { error: "Messages array is required" },
        { status: 400 }
      );
    }

    // Filter out messages with empty/null content and provide defaults
    const openaiMessages = messages
      .filter((msg: ChatMessage) => msg.text || msg.content) // Filter out empty messages
      .map((msg: ChatMessage) => ({
        role: msg.role === "agent" ? "assistant" : msg.role,
        content: msg.text || msg.content || "" // Provide default empty string
      }));

    if (openaiMessages.length === 0) {
      return NextResponse.json(
        { error: "No valid messages found" },
        { status: 400 }
      );
    }

    info('CHAT', 'Generating response for messages:', openaiMessages.length);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: openaiMessages,
      max_tokens: 60, // Shorter responses for speed
      temperature: 0.7,
    });

    const responseText = completion.choices[0]?.message?.content?.trim() || "I didn't catch that. Could you please repeat?";

    info("CHAT", "Generated response successfully", {
      responseLength: responseText.length
    });

    return NextResponse.json({
      content: responseText,
      success: true
    });

  } catch (err) {
    error("CHAT", "Error generating response:", err);
    
    // Return a fallback response
    return NextResponse.json({
      content: "I'm having trouble processing that right now. Could you please try again?",
      success: false,
      error: err instanceof Error ? err.message : "Unknown error"
    }, { status: 500 });
  }
}
