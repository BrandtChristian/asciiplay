import { AUDIO_READ_FAILURE_REASON } from "./audio";
import type { ExportedFrame, FrameSource } from "./frames";
import { MP4_BITRATE, type Range } from "./timeline";

/** 128kbps is the conventional "sounds fine" rate for AAC; nothing here needs more precision. */
const AAC_BITRATE = 128_000;

export interface Mp4Options {
  fps: number;
  width: number;
  height: number;
  audio: { source: FrameSource; range: Range } | null;
  /**
   * Called when audio was requested but the file still came out silent. The caller already
   * knows audioAvailability said yes, so without this there is no way to tell "audio was never
   * requested" apart from "it was requested and quietly failed", which is the exact ambiguity
   * this whole feature exists to remove.
   */
  onAudioDropped?: (reason: string) => void;
  /**
   * Checked between the video and audio passes, not just left to the caller: the frame generator
   * ending early on abort does not throw, so without an explicit check here a cancelled export
   * still ran a full decode-and-AAC-encode pass over the marked range, which defaults to the
   * whole clip.
   */
  signal: AbortSignal;
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
  // wrong while opening it (a mid-flight decode error, say) still lets the video export finish,
  // because a silent MP4 beats no MP4 at all, but onAudioDropped is how the caller finds out the
  // file came out silent rather than being left to guess.
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
        options.onAudioDropped?.(AUDIO_READ_FAILURE_REASON);
      }
    } catch {
      input.dispose();
      options.onAudioDropped?.(AUDIO_READ_FAILURE_REASON);
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

    // Aborting stops renderRange from yielding more frames, but the for-await above then simply
    // ends early rather than throwing, so cancellation would otherwise fall straight through into
    // the audio pass below, which decodes and AAC-encodes the entire marked range with the cancel
    // button inert and the progress readout frozen for as long as that takes.
    options.signal.throwIfAborted();

    if (audioMux) {
      try {
        // AudioBufferSource places buffers back to back from its own start (default 0) rather
        // than at their original timestamps, so trimming to the range here is what makes the
        // audio track line up with the video track, which also starts its own frames at 0.
        for await (const { buffer } of audioMux.sink.buffers(
          audioMux.range.inSeconds,
          audioMux.range.outSeconds,
        )) {
          await audioMux.source.add(buffer);
        }
      } catch {
        // A failure partway through still leaves a shorter audio track muxed rather than none,
        // but the file is not what was asked for, so report it the same as a failure at setup.
        options.onAudioDropped?.(AUDIO_READ_FAILURE_REASON);
      }
    }
  } catch (error) {
    // mediabunny creates its encoders lazily on the first add(), so by the time either loop
    // above can throw or be aborted, a real WebCodecs encoder may already be running. Without
    // this, a throw here (a mid-flight decode error, an abort) abandons the Output and leaks it;
    // discarding the blob afterward, which is all the caller did before, never releases it.
    await output.cancel();
    throw error;
  } finally {
    audioMux?.input.dispose();
  }

  await output.finalize();
  return new Blob([output.target.buffer!], { type: "video/mp4" });
}
