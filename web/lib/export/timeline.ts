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
 * Measured, not guessed, and modelled on pixel area rather than cell count: a per-cell model
 * looked right at the column count it was calibrated against (110) and fell apart at a second
 * one (60), because changing `columns` barely changes the exported pixel dimensions, it mostly
 * changes how chunky each cell is. Three real exports of big-buck-bunny.mp4, all a 1 second
 * range except where noted:
 *   1100x620 (110 columns), 12 frames, 1,752,921 bytes -> 0.2142 bytes/pixel
 *   1140x646 (60 columns),  12 frames, 1,310,981 bytes -> 0.1483 bytes/pixel
 *   1100x620 (110 columns), 60 frames (8s to 13s range), 8,050,633 bytes -> 0.1967 bytes/pixel
 * Calibrated at 0.21, the top of that range rather than the mean, because this constant feeds
 * exceedsCeiling's refusal: overestimating means an occasional borderline GIF gets refused when
 * it would have fit, underestimating means a GIF that will not fit sails past the refusal and a
 * tab is left building one that wedges it. See the 2026-09-09 entry in development-log.md for
 * the full measurement, including the earlier per-cell model this replaced.
 */
const GIF_BYTES_PER_PIXEL = 0.21;
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
  width: number,
  height: number,
): number {
  if (format === "mp4") {
    // Bitrate times duration: independent of pixel dimensions, so width/height go unused here.
    return Math.round((frameCount / MP4_FPS) * (MP4_BITRATE / 8));
  }
  return Math.round(frameCount * width * height * GIF_BYTES_PER_PIXEL);
}

export function exceedsCeiling(format: ExportFormat, bytes: number): boolean {
  // Only GIF is capped. An MP4 of these dimensions stays small on its own.
  return format === "gif" && bytes > GIF_MAX_BYTES;
}
