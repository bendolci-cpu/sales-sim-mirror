import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const text = searchParams.get('text');
  
  if (!text) {
    return NextResponse.json({ error: 'Text parameter is required' }, { status: 400 });
  }

  // If client TTS mode is enabled, return 204 (no audio)
  if (process.env.NEXT_PUBLIC_TTS_MODE === 'client') {
    return new NextResponse(null, { status: 204 });
  }

  try {
    // Check if ElevenLabs is configured
    const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
    const elevenLabsVoiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Default voice

    if (elevenLabsApiKey) {
      // Use ElevenLabs TTS
      const audioBuffer = await generateElevenLabsTTS(text, elevenLabsApiKey, elevenLabsVoiceId);
      
      return new NextResponse(audioBuffer, {
        headers: {
          'Content-Type': 'audio/mpeg',
          'Content-Length': audioBuffer.byteLength.toString(),
        },
      });
    } else {
      // No TTS provider configured
      return NextResponse.json(
        { error: 'No TTS provider configured. Set ELEVENLABS_API_KEY for server-side TTS or NEXT_PUBLIC_TTS_MODE=client for client-side TTS.' },
        { status: 501 }
      );
    }
  } catch (error) {
    console.error('TTS error:', error);
    
    // If it's a provider error, return 502
    if (error instanceof Error && error.message.includes('ElevenLabs')) {
      return NextResponse.json(
        { error: 'TTS provider error' },
        { status: 502 }
      );
    }
    
    return NextResponse.json(
      { error: 'Failed to generate TTS audio' },
      { status: 500 }
    );
  }
}

async function generateElevenLabsTTS(text: string, apiKey: string, voiceId: string): Promise<ArrayBuffer> {
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'Accept': 'audio/mpeg',
      'Content-Type': 'application/json',
      'xi-api-key': apiKey,
    },
    body: JSON.stringify({
      text: text,
      model_id: 'eleven_monolingual_v1',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.5,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`ElevenLabs API error: ${response.status} ${response.statusText}`);
  }

  return await response.arrayBuffer();
}

export async function POST(request: NextRequest) {
  try {
    const { text } = await request.json();
    if (!text) {
      return NextResponse.json(
        { error: 'Text is required' },
        { status: 400 }
      );
    }
    
    // For POST requests, use the same logic as GET
    const url = new URL(request.url);
    url.searchParams.set('text', text);
    
    return GET(request);
  } catch (error) {
    console.error('TTS POST error:', error);
    return NextResponse.json(
      { error: 'Failed to process TTS request' },
      { status: 500 }
    );
  }
}
