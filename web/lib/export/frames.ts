import type { Layout, RenderMode } from "../ascii";
import type { MonoInk } from "../mono";
import { createFrameCanvases, renderFrame } from "../render-frame";

export interface FrameSource {
  url: string;
  /** Present for a file the user opened. Bundled clips have only a URL. */
  file?: File;
}

export interface RenderSettings {
  mode: RenderMode;
  monoInk: MonoInk;
  charsetRamp: string;
  columns: number;
  cellWidth: number;
}

export interface ExportedFrame {
  canvas: HTMLCanvasElement;
  layout: Layout;
}

/** Dynamic so the encoder never lands in the initial page bundle. */
async function open(source: FrameSource) {
  const { ALL_FORMATS, BlobSource, Input, UrlSource } = await import("mediabunny");
  return new Input({
    formats: ALL_FORMATS,
    source: source.file ? new BlobSource(source.file) : new UrlSource(source.url),
  });
}

export async function canDecode(source: FrameSource): Promise<boolean> {
  const input = await open(source);
  try {
    const track = await input.getPrimaryVideoTrack();
    return track ? await track.canDecode() : false;
  } finally {
    input.dispose();
  }
}

export async function* renderRange(
  source: FrameSource,
  timestamps: number[],
  settings: RenderSettings,
  signal: AbortSignal,
): AsyncGenerator<ExportedFrame> {
  const { VideoSampleSink } = await import("mediabunny");
  const input = await open(source);
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("that file has no video track");

    // The player's clock is zero based, since browsers normalise <video>.currentTime that way
    // regardless of the container. mediabunny instead works in the track's own timestamp space,
    // and a track's first packet is not always at zero (an edit list, or B-frames with an
    // initial offset: big-buck-bunny.mp4 itself starts its video stream at 6.625s). Requesting
    // samples without this offset silently matches nothing and yields an empty video.
    const offset = await track.getFirstTimestamp();
    const trackTimestamps = timestamps.map((seconds) => seconds + offset);

    // Export owns its canvases rather than borrowing the preview's, so a running export cannot
    // fight the live loop over canvas dimensions.
    const canvases = createFrameCanvases(document.createElement("canvas"));
    const sink = new VideoSampleSink(track);

    for await (const sample of sink.samplesAtTimestamps(trackTimestamps)) {
      if (signal.aborted) return;
      if (!sample) continue;
      const frame = renderFrame(canvases, {
        source: sample.toCanvasImageSource(),
        sourceWidth: sample.displayWidth,
        sourceHeight: sample.displayHeight,
        mode: settings.mode,
        monoInk: settings.monoInk,
        charsetRamp: settings.charsetRamp,
        columns: settings.columns,
        cellWidth: settings.cellWidth,
        // Never devicePixelRatio: an export's size must not depend on the monitor.
        pixelRatio: 1,
      });
      sample.close();
      if (!frame) throw new Error("could not get a canvas context for export");
      yield { canvas: canvases.display, layout: frame.layout };
    }
  } finally {
    input.dispose();
  }
}
