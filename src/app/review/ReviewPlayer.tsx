"use client";
// IMPORTANT: This component should NEVER call web-speech, TTS, mic, or LiveKit
// It only plays pre-recorded audio files sequentially for AGENT turns only
import { useMemo, useState, useRef } from "react";

type Turn = { role: "user" | "assistant" | "agent"; text: string; url?: string | null; audioUrl?: string | null };

export default function ReviewPlayer({ turns }: { turns: Turn[] }) {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playingRef = useRef(false);
  const hasAutoPlayedRef = useRef(false);
  
    // Filter turns with audio and deduplicate agent turns
  const turnsWithAudio = useMemo(() => {
    console.log("[ReviewPlayer] All turns:", turns);
    console.log("[ReviewPlayer] Turn details:", turns.map(t => ({ role: t.role, url: t.url, audioUrl: t.audioUrl, hasUrl: !!t.url, hasAudioUrl: !!t.audioUrl })));
    
    // Play ALL turns that have a URL (both user and agent turns)
    // Note: API uses "agent" role, not "assistant"
    // Skip blob URLs as they don't persist across page loads
    const filtered = (turns || []).filter(t => {
      const url = t.url || t.audioUrl;
      return url && !url.startsWith('blob:');
    });
    console.log("[ReviewPlayer] All turns with URLs:", filtered);
    
    // Prevent auto-play on first load
    if (!hasAutoPlayedRef.current && filtered.length > 0) {
      hasAutoPlayedRef.current = true;
      console.log("[ReviewPlayer] Preventing auto-play on first load");
      
      // Also stop any existing audio that might be playing
      const audioElements = document.querySelectorAll('audio');
      audioElements.forEach(audio => {
        try {
          audio.pause();
          audio.currentTime = 0;
          audio.src = '';
        } catch (e) {
          console.warn("[ReviewPlayer] Failed to stop audio element:", e);
        }
      });
    }
    
    const deduplicated: Turn[] = [];
    
    for (let i = 0; i < filtered.length; i++) {
      const current = filtered[i];
      const previous = deduplicated[deduplicated.length - 1];
      
      // Skip duplicate turns (same text as previous turn of same role)
      if (previous && 
          previous.role === current.role && 
          current.text === previous.text) {
        console.log("[ReviewPlayer] Skipping duplicate turn:", current.text);
        continue;
      }
      
      deduplicated.push(current);
    }
    
    console.log("[ReviewPlayer] Final turns to play:", deduplicated);
    return deduplicated;
  }, [turns]);

  async function handlePlay() {
    console.log("[ReviewPlayer] Play button clicked");
    console.log("[ReviewPlayer] Current state - playing:", playing, "turnsWithAudio.length:", turnsWithAudio.length);
    
    if (playing || turnsWithAudio.length === 0) {
      console.log("[ReviewPlayer] Not playing - already playing or no audio");
      return;
    }
    
    setPlaying(true);
    playingRef.current = true;
    console.log("[ReviewPlayer] Set playing to true");
    
    try {
      // Create single audio element
      if (!audioRef.current) {
        console.log("[ReviewPlayer] Creating new audio element");
        audioRef.current = new Audio();
        audioRef.current.volume = 1.0;
        audioRef.current.playbackRate = 1.0;
      }
      
      console.log("[ReviewPlayer] Audio element ready:", audioRef.current);
      
      const audio = audioRef.current;
      const urls = turnsWithAudio.map(t => {
        // Get URL from either url or audioUrl field
        const audioUrl = t.url || t.audioUrl;
        
        // Ensure URLs have leading slash unless they're blob URLs
        if (audioUrl && !audioUrl.startsWith("blob:") && !audioUrl.startsWith("/")) {
          return `/${audioUrl}`;
        }
        return audioUrl!;
      });
      
      console.log("[ReviewPlayer] Playing turns:", turnsWithAudio.length);
      console.log("[ReviewPlayer] URLs:", urls);
      
      // Play sequentially
      for (const url of urls) {
              console.log("[ReviewPlayer] Playing URL:", url);
      console.log("[ReviewPlayer] Current playing state:", playingRef.current);
      console.log("[ReviewPlayer] Turn role:", turnsWithAudio[urls.indexOf(url)]?.role);
        
        // Check if we should still be playing
        if (!playingRef.current) {
          console.log("[ReviewPlayer] Stopped playing, breaking loop");
          break; // Check if still playing (user might have stopped)
        }
        
        console.log("[ReviewPlayer] Setting audio src to:", url);
        
        audio.src = url;
        
        // Retry logic for autoplay
        try {
          console.log("[ReviewPlayer] Attempting to play audio...");
          await audio.play();
          console.log("[ReviewPlayer] Audio play successful");
        } catch (e) {
          console.warn("[ReviewPlayer] Autoplay failed, retrying with muted:", e);
          audio.muted = true;
          await audio.play();
          audio.muted = false;
          console.log("[ReviewPlayer] Audio play successful after muted retry");
        }
        
        console.log("[ReviewPlayer] Waiting for audio to end...");
        
        // Wait for audio to end
        await new Promise<void>((resolve) => {
          const onEnded = () => {
            console.log("[ReviewPlayer] Audio ended for:", url);
            audio.removeEventListener("ended", onEnded);
            audio.removeEventListener("error", onError);
            resolve();
          };
          const onError = (e: Event) => {
            console.warn("[ReviewPlayer] Audio error, skipping:", url, e);
            audio.removeEventListener("ended", onEnded);
            audio.removeEventListener("error", onError);
            resolve(); // Continue to next audio instead of rejecting
          };
          audio.addEventListener("ended", onEnded, { once: true });
          audio.addEventListener("error", onError, { once: true });
        });
        
        console.log("[ReviewPlayer] Finished playing:", url);
      }
    } catch (error) {
      console.error("[ReviewPlayer] Playback error:", error);
    } finally {
      console.log("[ReviewPlayer] Playback finished, cleaning up...");
      setPlaying(false);
      playingRef.current = false;
      // Clean up audio element
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
      }
    }
  }

  return (
    <button 
      onClick={handlePlay} 
      disabled={playing || turnsWithAudio.length === 0}
      title={turnsWithAudio.length === 0 ? "No audio for this review" : undefined}
      className="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50 hover:bg-blue-700"
    >
      {playing ? "Playing..." : "Play Call"}
    </button>
  );
}
