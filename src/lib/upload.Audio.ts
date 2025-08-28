// src/lib/uploadAudio.ts
export async function uploadAudioBlob(blob: Blob, ext = "webm"): Promise<string> {
    const fd = new FormData();
    fd.append("file", blob, `clip.${ext}`);
    fd.append("name", "user-audio");
  
    const res = await fetch("/api/upload-audio", { method: "POST", body: fd });
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  
    const json = await res.json();
    return json.url as string; // e.g. /api/audio/<id>
  }

export async function uploadBlobGetUrl(blob: Blob): Promise<string> {
  return uploadAudioBlob(blob);
}