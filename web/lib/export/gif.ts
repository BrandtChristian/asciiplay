import type { ExportedFrame } from "./frames";

export interface GifOptions {
  fps: number;
  width: number;
  height: number;
}

/** GIF's colour table is a hard format ceiling (8 bits per pixel), not a quality knob. */
const GIF_PALETTE_COLORS = 256;

export async function encodeGif(
  frames: AsyncIterable<ExportedFrame>,
  options: GifOptions,
): Promise<Blob> {
  const { applyPalette, GIFEncoder, quantize } = await import("gifenc");

  const canvas = document.createElement("canvas");
  canvas.width = options.width;
  canvas.height = options.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("could not get a canvas context for encoding");

  const encoder = GIFEncoder();
  // GIF frame delays are centiseconds, so a frame rate that does not divide 100 is rounded to
  // the nearest one before being handed to gifenc, which takes milliseconds and rounds again.
  const delay = Math.round(100 / options.fps) * 10;

  for await (const frame of frames) {
    context.drawImage(frame.canvas, 0, 0, options.width, options.height);
    const { data } = context.getImageData(0, 0, options.width, options.height);
    const palette = quantize(data, GIF_PALETTE_COLORS);
    encoder.writeFrame(applyPalette(data, palette), options.width, options.height, {
      palette,
      delay,
    });
  }

  encoder.finish();
  return new Blob([encoder.bytesView()], { type: "image/gif" });
}
