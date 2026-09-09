import type { ExportedFrame } from "./frames";
import { MP4_BITRATE } from "./timeline";

export interface Mp4Options {
  fps: number;
  width: number;
  height: number;
}

export async function canEncodeMp4(): Promise<boolean> {
  const { canEncodeVideo } = await import("mediabunny");
  return canEncodeVideo("avc");
}

export async function encodeMp4(
  frames: AsyncIterable<ExportedFrame>,
  options: Mp4Options,
): Promise<Blob> {
  const { BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality } =
    await import("mediabunny");

  const canvas = document.createElement("canvas");
  canvas.width = options.width;
  canvas.height = options.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("could not get a canvas context for encoding");

  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  // `quality`, not the deprecated `bitrate`: see docs/reference/mediabunny-1.56-api.md.
  const videoSource = new CanvasSource(canvas, {
    codec: "avc",
    quality: new Quality({ bitrate: MP4_BITRATE }),
  });
  output.addVideoTrack(videoSource, { frameRate: options.fps });
  await output.start();

  let index = 0;
  for await (const frame of frames) {
    context.drawImage(frame.canvas, 0, 0, options.width, options.height);
    await videoSource.add(index / options.fps, 1 / options.fps);
    index += 1;
  }

  await output.finalize();
  return new Blob([output.target.buffer!], { type: "video/mp4" });
}
