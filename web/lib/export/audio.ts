import type { FrameSource } from "./frames";

export type AudioAvailability = { kind: "available" } | { kind: "unavailable"; reason: string };

/**
 * Shared between the pre-export availability check and encodeMp4's own late failure path, so a
 * probing error and a mid-encode error read the same to the user: both mean audioAvailability
 * said yes but something still went wrong, as opposed to the more specific reasons above, which
 * mean it said no up front.
 */
export const AUDIO_READ_FAILURE_REASON = "could not read the audio, exporting silent";

export function silentBecauseOfSpeed(speed: number): boolean {
  return speed !== 1;
}

/** Registers the fallback encoder only when the browser lacks a native one. */
export async function ensureAacEncoder(): Promise<boolean> {
  const { canEncodeAudio } = await import("mediabunny");
  if (await canEncodeAudio("aac")) return true;
  try {
    const { registerAacEncoder } = await import("@mediabunny/aac-encoder");
    registerAacEncoder();
    return await canEncodeAudio("aac");
  } catch {
    return false;
  }
}

export async function audioAvailability(
  source: FrameSource,
  speed: number,
): Promise<AudioAvailability> {
  if (silentBecauseOfSpeed(speed)) {
    return { kind: "unavailable", reason: "audio is dropped when the speed is not 1x" };
  }
  const { ALL_FORMATS, BlobSource, Input, UrlSource } = await import("mediabunny");
  const input = new Input({
    formats: ALL_FORMATS,
    source: source.file ? new BlobSource(source.file) : new UrlSource(source.url),
  });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return { kind: "unavailable", reason: "that file has no audio track" };
    if (!(await track.canDecode())) {
      return { kind: "unavailable", reason: "this browser cannot decode that audio" };
    }
  } finally {
    input.dispose();
  }
  if (!(await ensureAacEncoder())) {
    return { kind: "unavailable", reason: "this browser cannot encode AAC, so the MP4 is silent" };
  }
  return { kind: "available" };
}
