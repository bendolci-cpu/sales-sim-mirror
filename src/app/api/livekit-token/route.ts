import { NextRequest, NextResponse } from "next/server";
import { AccessToken } from "livekit-server-sdk";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const name = searchParams.get('name') || 'test-user';
    const room = searchParams.get('room') || 'sales-sim';
    
    const url = process.env.NEXT_PUBLIC_LIVEKIT_URL;
    const key = process.env.LIVEKIT_API_KEY;
    const secret = process.env.LIVEKIT_API_SECRET;
    
    if (!url || !key || !secret) {
      return NextResponse.json({ 
        error: "LiveKit server not configured. Missing LIVEKIT_URL, LIVEKIT_API_KEY, or LIVEKIT_API_SECRET" 
      }, { status: 500 });
    }

    const at = new AccessToken(key, secret, { identity: name });
    at.addGrant({
      roomJoin: true,
      room: room,
      canPublish: true,
      canSubscribe: true,
    });

    const token = await at.toJwt();
    return NextResponse.json({ token });
  } catch (e: unknown) {
    console.error('LiveKit token error:', e);
    const errorMessage = e instanceof Error ? e.message : "Token generation failed";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { roomName, identity } = await req.json();
    if (!roomName || !identity) {
      return NextResponse.json({ error: "Missing roomName or identity" }, { status: 400 });
    }
    
    const url = process.env.NEXT_PUBLIC_LIVEKIT_URL;
    const key = process.env.LIVEKIT_API_KEY;
    const secret = process.env.LIVEKIT_API_SECRET;
    
    if (!url || !key || !secret) {
      return NextResponse.json({ error: "LiveKit server not configured" }, { status: 500 });
    }

    const at = new AccessToken(key, secret, { identity });
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    });

    const token = await at.toJwt();
    return NextResponse.json({ token });
  } catch (e: unknown) {
    console.error('LiveKit token error:', e);
    const errorMessage = e instanceof Error ? e.message : "Token error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
