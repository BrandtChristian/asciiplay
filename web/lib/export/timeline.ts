export type ExportFormat = "mp4" | "gif";

export interface Range {
  inSeconds: number;
  outSeconds: number;
}

export interface TimelineRequest extends Range {
  fps: number;
  speed: number;
}

export const MP4_FPS = 30;
/** GIF at 30fps is enormous, and 12 is enough for a clip in a slide. */
export const GIF_FPS = 12;
export const GIF_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Empirical, and deliberately so: a quantised GIF frame of ASCII costs roughly this per cell
 * after LZW, because large flat runs compress hard. Calibrate it against a real export rather
 * than trusting it, and see the note in Task 5.
 */
const GIF_BYTES_PER_CELL = 0.5;
/** Bitrate the MP4 encoder is asked for, so the estimate and the encoder agree. */
export const MP4_BITRATE = 2_000_000;

export function fpsFor(format: ExportFormat): number {
  return format === "mp4" ? MP4_FPS : GIF_FPS;
}

/**
 * Source timestamps for each output frame.
 *
 * Output frame i is shown at i/fps and samples the source at in + i * speed / fps, so the
 * speed control the user already tuned carries into the file rather than being ignored.
 * Always at least one frame: an empty file is a worse answer than a single frame.
 */
export function frameTimestamps(request: TimelineRequest): number[] {
  const { inSeconds, outSeconds, fps, speed } = request;
  const step = speed / fps;
  const span = outSeconds - inSeconds;
  const count = Math.max(1, Math.floor(span / step));
  return Array.from({ length: count }, (_unused, index) => inSeconds + index * step);
}

export function estimatedBytes(
  format: ExportFormat,
  frameCount: number,
  cellColumns: number,
  cellRows: number,
): number {
  if (format === "mp4") {
    return Math.round((frameCount / MP4_FPS) * (MP4_BITRATE / 8));
  }
  return Math.round(frameCount * cellColumns * cellRows * GIF_BYTES_PER_CELL);
}

export function exceedsCeiling(format: ExportFormat, bytes: number): boolean {
  // Only GIF is capped. An MP4 of these dimensions stays small on its own.
  return format === "gif" && bytes > GIF_MAX_BYTES;
}
