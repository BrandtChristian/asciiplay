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

    // Export owns its canvases rather than borrowing the preview's, so a running export cannot
    // fight the live loop over canvas dimensions.
    const canvases = createFrameCanvases(document.createElement("canvas"));
    const sink = new VideoSampleSink(track);

    // Player time and track time are the same timeline: `<video>.currentTime` is not
    // renormalised per track, so no offset belongs here. A track's own first packet is not
    // necessarily at zero, though: this player's own bundled big-buck-bunny.mp4 has its AAC
    // audio starting at 0 but its video only from 6.625s to 18s, so the first ~6.6s of player
    // time is a real audio-only lead-in with no video sample at all. (An earlier version of this
    // function added track.getFirstTimestamp() as an offset, on the wrong assumption that a
    // nonzero track start meant the player's clock had been renormalised around it. That shifted
    // every export 6.625s late and, past the track's end, overshot and clamped to the last
    // frame. Measured against captured reference frames, not just inferred.)
    let matched = 0;
    for await (const sample of sink.samplesAtTimestamps(timestamps)) {
      if (signal.aborted) {
        // The sink already decoded this sample before the abort was noticed, so it is not the
        // caller's to leak: without this close, cancelling mid-export leaks one decoded frame.
        sample?.close();
        return;
      }
      if (!sample) continue;
      matched += 1;
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
    // A range entirely inside a video-less lead-in (or otherwise outside the track) matches
    // nothing. Encoding that would silently hand back a valid but empty MP4, so the caller needs
    // a real error to show instead.
    if (matched === 0) throw new Error("that range has no video in it");
  } finally {
    input.dispose();
  }
}
