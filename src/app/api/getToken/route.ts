import { NextRequest, NextResponse } from "next/server";
import { AccessToken } from "livekit-server-sdk";

export const runtime = "nodejs"; // make sure Node runtime is used (not edge)

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const identity = searchParams.get("identity") ?? "anon";
    const roomName = searchParams.get("roomName") ?? "sales-sim";
  
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
  
    // 🔍 DEBUG LOG
    console.log("LiveKit ENV check:", {
        apiKeyHead: apiKey?.slice(0, 6),
        apiSecretLength: apiSecret?.length,
      });
      
    if (!apiKey || !apiSecret) {
      console.error("Missing LiveKit envs", { hasKey: !!apiKey, hasSecret: !!apiSecret });
      return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    }
  
    const at = new AccessToken(apiKey, apiSecret, {
      identity,
      ttl: "10m",
    });
  
    at.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });
  
    const jwt = await at.toJwt();
    return NextResponse.json({ token: jwt });
  }