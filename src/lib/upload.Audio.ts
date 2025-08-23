// src/lib/uploadAudio.ts
export async function uploadAudioBlob(blob: Blob, ext = "webm"): Promise<string> {
    const fd = new FormData();
    fd.append("audio", blob, `clip.${ext}`);
    fd.append("ext", ext);
  
    const res = await fetch("/api/upload-audio", { method: "POST", body: fd });
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  
    const json = await res.json();
    return json.url as string; // e.g. /api/audio/<id>
  }