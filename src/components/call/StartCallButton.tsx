"use client";

import { useState } from "react";
import {
  Room,
  RoomEvent,
  RemoteParticipant,
  createLocalAudioTrack,
} from "livekit-client";

export default function StartCallButton() {
  const [room, setRoom] = useState<Room | null>(null);

  async function startCall() {
    try {
      // 1. Fetch a token from your backend
      const res = await fetch(
        `/api/getToken?identity=test-user&roomName=sales-sim`
      );
      const data = await res.json();
      const token = data.token;

      if (!token) {
        console.error("No token received from server");
        return;
      }

      // 2. Connect to LiveKit Cloud
      const url = process.env.NEXT_PUBLIC_LIVEKIT_URL!;
      const newRoom = new Room();
      await newRoom.connect(url, token);

      console.log("Connected to LiveKit as", newRoom.localParticipant.identity);

      // 3. Publish mic audio
      const audioTrack = await createLocalAudioTrack();
      await newRoom.localParticipant.publishTrack(audioTrack);

      console.log("Mic audio published");

      // 4. Listen for participants and tracks
      newRoom
        .on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
          console.log("Participant connected:", p.identity);
        })
        .on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
          console.log("Subscribed to track:", participant.identity);
          if (track.kind === "audio") {
            const audioEl = track.attach();
            document.body.appendChild(audioEl);
          }
        });

      setRoom(newRoom);
    } catch (err) {
      console.error("Error starting call:", err);
    }
  }

  async function stopCall() {
    if (room) {
      await room.disconnect();
      setRoom(null);
      console.log("Disconnected from LiveKit");
    }
  }

  return (
    <div className="flex gap-2">
      {!room ? (
        <button
          onClick={startCall}
          className="px-4 py-2 bg-blue-600 text-white rounded-md"
        >
          Start Call
        </button>
      ) : (
        <button
          onClick={stopCall}
          className="px-4 py-2 bg-red-600 text-white rounded-md"
        >
          Stop Call
        </button>
      )}
    </div>
  );
}