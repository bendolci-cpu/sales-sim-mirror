import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { join } from 'path';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const text = searchParams.get('text') || 'Hello world';
  
  try {
    // For now, return a simple beep sound
    // In production, this would call your actual TTS service
    const audioBuffer = generateMockAudioBuffer(text);
    
    return new NextResponse(audioBuffer, {
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': audioBuffer.byteLength.toString(),
      },
    });
  } catch (error) {
    console.error('TTS error:', error);
    return NextResponse.json(
      { error: 'Failed to generate TTS audio' },
      { status: 500 }
    );
  }
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
    
    const audioBuffer = generateMockAudioBuffer(text);
    
    return new NextResponse(audioBuffer, {
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': audioBuffer.byteLength.toString(),
      },
    });
  } catch (error) {
    console.error('TTS error:', error);
    return NextResponse.json(
      { error: 'Failed to generate TTS audio' },
      { status: 500 }
    );
  }
}

function generateMockAudioBuffer(text: string): ArrayBuffer {
  // Create a simple sine wave audio buffer
  const sampleRate = 24000;
  const duration = Math.max(0.5, text.length * 0.05); // 50ms per character, minimum 500ms
  const numSamples = Math.floor(sampleRate * duration);
  
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
