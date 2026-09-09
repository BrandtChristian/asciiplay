# mediabunny API, read from the installed types

Read from `mediabunny@1.56.0`'s `dist/mediabunny.d.ts` on 2026-09-09, in a scratch install, not
guessed and not taken from the published docs. These resolve the two details the spec and plan
deliberately left open. Use these forms.

## Encoding a canvas to MP4

`VideoEncodingConfig` carries BOTH `quality` and `bitrate`, and **`bitrate` is marked
`@deprecated Use quality instead`**. That is the disagreement between mediabunny's README and its
guide, settled: `quality` is current.

```ts
constructor(canvas: HTMLCanvasElement | OffscreenCanvas, encodingConfig: VideoEncodingConfig);

type VideoEncodingConfig = {
  codec: VideoCodec;
  quality?: Quality;
  bitrate?: number | Quality;   // deprecated, do not use
  keyFrameInterval?: number;    // default 2 seconds
  sizeChangeBehavior?: 'deny' | 'passThrough' | 'fill' | 'contain' | 'cover';  // default 'deny'
};

class Quality {
  constructor(options: QualityOptions | number | QualityLevel);
}
// QuantitativeQualityOptions = { bitrate?: number; ... }, bits per second.
```

So the correct construction is:

```ts
const videoSource = new CanvasSource(canvas, {
  codec: "avc",
  quality: new Quality({ bitrate: MP4_BITRATE }),
});
```

Adding the track and the frames, both confirmed:

```ts
addVideoTrack(source: VideoSource, metadata?: VideoTrackMetadata): OutputVideoTrack;
// VideoTrackMetadata.frameRate?: number
add(timestamp: number, duration?: number, encodeOptions?: VideoEncoderEncodeOptions): Promise<void>;
```

`frameRate` is worth setting for more than metadata. Its own doc says: "If set, all timestamps
and durations of this track will be snapped to this frame rate. You should avoid adding more
frames than the rate allows, as this will lead to multiple frames with the same timestamp." That
snapping is exactly the determinism this feature exists for.

Note `sizeChangeBehavior` defaults to `'deny'`, which throws if a later frame's dimensions differ
from the first. Since the export canvas is sized once before encoding and never resized, the
default is correct and should be left alone. It also means a mid-export dimension change becomes
a loud error rather than a corrupt file, which is the behaviour we want.

## Reading frames out of the input

Both of the plan's guesses here were right:

```ts
samplesAtTimestamps(
  timestamps: AnyIterable<number>,
  options?: PacketRetrievalOptions,
): AsyncGenerator<VideoSample | null, void, unknown>;
```

It yields `null` for a timestamp with no sample, so the plan's `if (!sample) continue;` is
required, not defensive noise.

`VideoSample` really does expose `toCanvasImageSource(): OffscreenCanvas | VideoFrame`, so the
plan's Step 4 needs no fallback. `displayWidth` and `displayHeight` are getters and are the right
dimensions to pass, since they account for pixel aspect ratio where `codedWidth` does not. There
is also `draw(context, dx, dy, dWidth?, dHeight?)` if drawing directly is ever preferable.

Always `sample.close()` when done with one, which the plan already does.

## Audio, for Task 6

The pairing to use is `AudioBufferSink` to read decoded audio out of the input, and
`AudioBufferSource` to write it to the output. Both exist as exported classes. The alternatives
are `AudioSampleSink` with `AudioSampleSource`, or `EncodedPacketSink` with
`EncodedAudioPacketSource` for a packet copy, which the spec already ruled out because trimming
from a non-zero start forces a transcode anyway.

Capability checks, both confirmed as exported consts rather than functions on a namespace:

```ts
const canEncodeVideo: (codec: VideoCodec, options?: {...}) => Promise<boolean>;
const canEncodeAudio: (codec: AudioCodec, options?: {...}) => Promise<boolean>;
```

## Versions installed in the probe

`mediabunny@1.56.0`, `@mediabunny/aac-encoder@1.56.0`, `gifenc@1.0.3`. The aac-encoder tracks
mediabunny's version exactly, which suggests pinning them together rather than letting them
drift apart.
