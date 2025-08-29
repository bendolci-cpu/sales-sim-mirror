import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const text = searchParams.get('text');
  
  if (!text) {
    return NextResponse.json({ error: 'Text parameter is required' }, { status: 400 });
  }
  
  try {
    // Generate a short audio buffer instead of returning a 404 URL
    const audioBuffer = generateMockAudioBuffer(text);
    const blob = new Blob([audioBuffer], { type: 'audio/wav' });
    const audioUrl = URL.createObjectURL(blob);
    
    return NextResponse.json({ 
      audioUrl: audioUrl,
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
    
    // Generate a short audio buffer instead of returning a 404 URL
    const audioBuffer = generateMockAudioBuffer(text);
    const blob = new Blob([audioBuffer], { type: 'audio/wav' });
    const audioUrl = URL.createObjectURL(blob);
    
    return NextResponse.json({ 
      url: audioUrl,
      text: text
    });
    
  } catch (error) {
    console.error('TTS API error:', error);
    return NextResponse.json({ error: 'TTS generation failed' }, { status: 500 });
  }
}

// Generate a simple audio buffer for mock TTS
function generateMockAudioBuffer(text: string): ArrayBuffer {
  // Create a simple sine wave audio buffer
  const sampleRate = 24000;
  const duration = Math.max(0.5, text.length * 0.05); // 50ms per character, minimum 500ms
  const numSamples = Math.floor(sampleRate * duration);
  
  // Create a simple beep sound
  const frequency = 440; // A4 note
  const amplitude = 0.3;
  
  const buffer = new ArrayBuffer(numSamples * 2); // 16-bit samples
  const view = new Int16Array(buffer);
  
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.sin(2 * Math.PI * frequency * i / sampleRate);
    view[i] = Math.floor(sample * amplitude * 32767);
  }
  
  return buffer;
}
