import { NextRequest, NextResponse } from 'next/server';
import { AccessToken } from 'livekit-server-sdk';

export const runtime = 'nodejs'; // ensure Node runtime, not edge

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const identity = searchParams.get('identity') ?? 'anon';
  const roomName = searchParams.get('roomName') ?? 'sales-sim';

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    console.error('Missing LiveKit envs', { hasKey: !!apiKey, hasSecret: !!apiSecret });
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const at = new AccessToken(apiKey, apiSecret, { identity, ttl: 60 * 60 });

  // Just add the grant directly
  at.addGrant({
    roomJoin: true,
    room: roomName,
  });

  const jwt = await at.toJwt(); // must await
  return NextResponse.json({ token: jwt });
}