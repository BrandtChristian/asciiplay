import type { ExportedFrame, FrameSource } from "./frames";
import { MP4_BITRATE, type Range } from "./timeline";

/** 128kbps is the conventional "sounds fine" rate for AAC; nothing here needs more precision. */
const AAC_BITRATE = 128_000;

export interface Mp4Options {
  fps: number;
  width: number;
  height: number;
  audio: { source: FrameSource; range: Range } | null;
}

export async function canEncodeMp4(): Promise<boolean> {
  const { canEncodeVideo } = await import("mediabunny");
  return canEncodeVideo("avc");
}

export async function encodeMp4(
  frames: AsyncIterable<ExportedFrame>,
  options: Mp4Options,
): Promise<Blob> {
  const {
    ALL_FORMATS,
    AudioBufferSink,
    AudioBufferSource,
    BlobSource,
    BufferTarget,
    CanvasSource,
    Input,
    Mp4OutputFormat,
    Output,
    Quality,
    UrlSource,
  } = await import("mediabunny");

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

  // The audio track, if any, has to be attached before output.start(). The caller is expected
  // to have already run audioAvailability, so a track should be there; anything that still goes
  // wrong while opening it (a mid-flight decode error, say) is treated the same as "no audio
  // requested" rather than failing the export, because a silent MP4 beats no MP4 at all.
  type AudioMux = {
    input: InstanceType<typeof Input>;
    sink: InstanceType<typeof AudioBufferSink>;
    source: InstanceType<typeof AudioBufferSource>;
    range: Range;
  };
  let audioMux: AudioMux | null = null;
  if (options.audio) {
    const input = new Input({
      formats: ALL_FORMATS,
      source: options.audio.source.file
        ? new BlobSource(options.audio.source.file)
        : new UrlSource(options.audio.source.url),
    });
    try {
      const track = await input.getPrimaryAudioTrack();
      if (track) {
        const source = new AudioBufferSource({
          codec: "aac",
          quality: new Quality({ bitrate: AAC_BITRATE }),
        });
        output.addAudioTrack(source);
        audioMux = { input, sink: new AudioBufferSink(track), source, range: options.audio.range };
      } else {
        input.dispose();
      }
    } catch {
      input.dispose();
    }
  }

  try {
    await output.start();

    let index = 0;
    for await (const frame of frames) {
      context.drawImage(frame.canvas, 0, 0, options.width, options.height);
      await videoSource.add(index / options.fps, 1 / options.fps);
      index += 1;
    }

    if (audioMux) {
      // AudioBufferSource places buffers back to back from its own start (default 0) rather
      // than at their original timestamps, so trimming to the range here is what makes the
      // audio track line up with the video track, which also starts its own frames at 0.
      for await (const { buffer } of audioMux.sink.buffers(
        audioMux.range.inSeconds,
        audioMux.range.outSeconds,
      )) {
        await audioMux.source.add(buffer);
      }
    }
  } finally {
    audioMux?.input.dispose();
  }

  await output.finalize();
  return new Blob([output.target.buffer!], { type: "video/mp4" });
}
