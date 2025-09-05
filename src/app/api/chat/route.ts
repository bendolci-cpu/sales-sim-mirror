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

    // Track usage for budget management
    try {
      if (completion.usage) {
        await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/api/budget/track`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            usage: completion.usage
          })
        });
      }
    } catch (err) {
      error("CHAT", "Failed to track budget usage:", err);
      // Continue without budget tracking
    }

    // Generate TTS URL for the response
    let ttsUrl = null;
    try {
      const ttsResponse = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/api/tts?text=${encodeURIComponent(responseText)}`);
      if (ttsResponse.ok) {
        const ttsData = await ttsResponse.json();
        ttsUrl = ttsData.audioUrl;
      }
    } catch (err) {
      error("CHAT", "TTS generation failed:", err);
      // Continue without TTS - the response will still be returned
    }

    const response = {
      content: responseText,
      response: responseText, // For backward compatibility
      audioUrl: ttsUrl,
      success: true
    };

    info("CHAT", "Generated response successfully", {
      responseLength: responseText.length,
      hasTTS: !!ttsUrl
    });

    return NextResponse.json(response);

  } catch (err) {
    error("CHAT", "Error generating response:", err);
    
    // Return a fallback response even if TTS fails
    const fallbackResponse = {
      content: "I'm having trouble processing that right now. Could you please try again?",
      response: "I'm having trouble processing that right now. Could you please try again?",
      audioUrl: null,
      success: false,
      error: error instanceof Error ? error.message : "Unknown error"
    };

    return NextResponse.json(fallbackResponse, { status: 500 });
  }
}
