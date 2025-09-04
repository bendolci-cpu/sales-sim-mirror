import { NextResponse } from "next/server";
import { AccessToken } from "livekit-server-sdk";

export async function POST(req: Request) {
  try {
    const { roomName, identity } = await req.json();
    if (!roomName || !identity) {
      return NextResponse.json({ error: "Missing roomName or identity" }, { status: 400 });
    }
    
    const url = process.env.LIVEKIT_API_URL!;
    const key = process.env.LIVEKIT_API_KEY!;
    const secret = process.env.LIVEKIT_API_SECRET!;
    
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
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Token error" }, { status: 500 });
  }
}
