import { NextRequest, NextResponse } from 'next/server';
import { AccessToken } from 'livekit-server-sdk';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const room = searchParams.get('room') || 'sales-sim';
  const identity = searchParams.get('identity') || 'test-user';
  
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  
  if (!apiKey || !apiSecret) {
    return NextResponse.json(
      { error: 'LiveKit API credentials not configured' },
      { status: 500 }
    );
  }
  
  try {
    const at = new AccessToken(apiKey, apiSecret, {
      identity: identity,
      name: identity,
    });
    
    at.addGrant({
      room: room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });
    
    const token = at.toJwt();
    
    return NextResponse.json({ token });
  } catch (error) {
    console.error('LiveKit token generation error:', error);
    return NextResponse.json(
      { error: 'Failed to generate LiveKit token' },
      { status: 500 }
    );
  }
}
