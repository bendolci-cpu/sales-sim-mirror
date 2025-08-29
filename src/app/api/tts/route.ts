import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const text = searchParams.get('text');
  
  if (!text) {
    return NextResponse.json({ error: 'Text parameter is required' }, { status: 400 });
  }
  
  try {
    // For now, return a mock audio URL
    // In a real implementation, this would call a TTS service
    const mockAudioUrl = `/uploads/mock-tts-${Date.now()}.mp3`;
    
    return NextResponse.json({ 
      audioUrl: mockAudioUrl,
      text: text,
      duration: text.length * 50 // Rough estimate: 50ms per character
    });
    
  } catch (error) {
    console.error('TTS API error:', error);
    return NextResponse.json({ error: 'TTS generation failed' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const text = body.text || '';
    
    if (!text) {
      return NextResponse.json({ error: 'Text is required' }, { status: 400 });
    }
    
    // For now, return a mock audio URL
    // In a real implementation, this would call a TTS service
    const mockAudioUrl = `/uploads/mock-tts-${Date.now()}.mp3`;
    
    return NextResponse.json({ 
      url: mockAudioUrl,
      text: text
    });
    
  } catch (error) {
    console.error('TTS API error:', error);
    return NextResponse.json({ error: 'TTS generation failed' }, { status: 500 });
  }
}
