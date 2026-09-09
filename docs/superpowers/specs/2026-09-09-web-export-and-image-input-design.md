# Web export formats and image input

Status: approved design, not yet implemented.
Date: 2026-09-09.

## Why

The web player can already record, but only as a live capture: `MediaRecorder` over
`canvas.captureStream(30)`, which yields a WebM whose frame rate is whatever the browser
managed at the time. That is fine for a link and poor for a deck, because a busy machine shows
up as stutter in the file, the duration is however long you sat there, and the size is not ours
to control.

What is wanted instead: tune the render with the controls that already exist, mark a range, and
save a small clean MP4 or GIF fit for a presentation. Separately, an image should be usable as
a source, so a still can be ASCII-ified without pretending to be a video.

## Decisions

Each of these was chosen deliberately, so the rationale is recorded with it.

**Deterministic offline render, not realtime capture.** Export is a separate pass that decodes
chosen frames and encodes at an exact frame rate, rather than recording the preview. This is
the only version that produces a reproducible file with a frame rate we control.

**In and out points on the transport.** More UI than a duration picker, and chosen for the
precision.

**MP4 and GIF. WebM and the realtime capture are removed.** One export path, not two
mechanisms in a component that is already the largest file in the app.

**No WebM fallback for browsers that cannot encode H.264.** Accepted with its consequence:
WebCodecs `VideoEncoder` support for `avc` is not universal, so a browser that can export WebM
today may get GIF only afterwards. Which browsers those are should be established by running
`canEncodeVideo('avc')` rather than trusted to anyone's memory of a support table. Affected
users get an explicit notice, not a dead button. Reinstating WebM behind that same check is
about a dozen lines and a different muxer if it proves annoying in practice.

**MP4 carries the source audio where it can.** Native AAC when available, the
`@mediabunny/aac-encoder` extension when not, silent only if both fail. Trimming with a
non-zero start forces a full transcode in mediabunny, so there is no packet-copy shortcut to
chase and audio is re-encoded either way.

**Format and range are the only export controls.** Frame rate is fixed per format, 30 for MP4
and 12 for GIF, because GIF at 30 is enormous. Cell size comes from the preview the user
already tuned with the columns control. A live size estimate replaces a pile of knobs.

**Export renders at 1x, not `devicePixelRatio`.** Otherwise the size of an exported file
depends on which monitor the user happened to be sitting at, which is a bad surprise. Cell size
still follows the preview, so density matches what was tuned.

**When speed is not 1x the MP4 is silent.** Frame timestamps honour the speed control, because
a control that visibly changes the preview should not be silently ignored by the export. Pitch
correct audio resampling is a separate problem and out of scope, so the audio is dropped with a
notice rather than played at the wrong pitch.

**Images get a plain-text download alongside PNG.** The glyph rows already exist for the
clipboard copy, so a `.txt` file is the same data written to disk, which is what is actually
wanted for a README or a terminal banner.

## Architecture

### The central change

`components/AsciiPlayer.tsx` currently does canvas sizing, sample drawing, glyph drawing and
the multiply composite inline inside its `requestAnimationFrame` loop, reading the `<video>`
element directly. Every part of this feature depends on driving that renderer from something
that is not rAF and not a video element.

So the renderer is extracted into `lib/render-frame.ts`, taking any canvas image source plus
its intrinsic dimensions. A decoded `VideoSample` and an `HTMLImageElement` then work exactly
as well as a video element, which is what makes both offline export and image input cheap.

This also shrinks a 546-line component that presently mixes playback, rendering and export.

### Modules

- **`lib/ascii.ts`** unchanged. The maths, ramps, ANSI encoder and asciicast builder stay as
  they are.
- **`lib/render-frame.ts`** new. Owns the three canvases (display, glyph, sample),
  `measureMetrics`, the blocks/mono/colour branches and the composite. Returns
  `{ layout, rows, pixels }` so `.cast`, copy-as-text and the new `.txt` export all keep
  working from its output. Called by the live preview and by the exporter.
- **`lib/export/timeline.ts`** new, pure. Turns in, out, target frame rate and the speed
  control into an exact list of source timestamps. All the arithmetic worth unit testing lives
  here.
- **`lib/export/frames.ts`** new. mediabunny `Input` over the source, `VideoSampleSink`,
  `samplesAtTimestamps()`, yielding rendered frames as an async generator with progress and
  cancellation.
- **`lib/export/mp4.ts`** new. mediabunny `Output` with `Mp4OutputFormat`, a `CanvasSource`
  using the `avc` codec at a fixed 30fps, plus the audio track.
- **`lib/export/gif.ts`** new. gifenc over the same rendered frames at 12fps.
- **`components/ExportPanel.tsx`** new. Format choice, in/out readout, size estimate, progress,
  cancel and download.
- **`components/AsciiPlayer.tsx`** loses the `MediaRecorder` block, `webmChunksRef`, `webmUrl`
  and the inline draw code. Gains in/out state and the source discriminated union.

Both new dependencies are loaded with dynamic `import()`, so the initial load of the static page
is untouched by an encoder the visitor may never use.

### The source abstraction

The component currently assumes a video element throughout: `playbackRate`, `muted`,
`currentTime`, `duration`, `readyState`, `videoWidth`. Image input makes that assumption false,
so `source` becomes a discriminated union:

```ts
type Source =
  | { kind: "video"; label: string; url: string; file?: File }
  | { kind: "image"; label: string; url: string; file: File };
```

The original `File` has to be retained. Today `openFile` creates an object URL and throws the
`File` away, and mediabunny wants a `BlobSource(file)`, or a `UrlSource(url)` for the two
bundled clips.

In image mode the transport, speed, mute, in/out markers, MP4 and GIF are all absent rather
than disabled, because none of them mean anything for a still.

## Data flow

### A video export run

1. The user sets in and out on the transport and picks MP4 or GIF.
2. `timeline.ts` produces N timestamps, where output frame `i` maps to source time
   `in + i * speed / fps`.
3. `frames.ts` opens the source with mediabunny, pulls exactly those samples with
   `samplesAtTimestamps()`, draws each into the sample canvas via `sample.draw(ctx, ...)` and
   renders it through `render-frame.ts`.
4. Each rendered canvas goes to the MP4 or GIF encoder.
5. Finalize, produce a `Blob`, hand it to the `download()` helper that already exists.

Progress is frames completed over total, which is exact because we own the loop and knew the
frame count before starting.

### Image mode

Draw the image into the sample canvas once, render through `render-frame.ts`, and re-render on
any control change rather than on a rAF tick. Exports are PNG and, for ascii and mono modes,
`.txt`. Blocks mode paints pixels rather than glyphs and so has no text to give, which the
component already explains for the clipboard copy.

## Formats

**MP4.** `Output` with `Mp4OutputFormat` and `BufferTarget`, video from `CanvasSource` with
codec `avc`, `addVideoTrack(source, { frameRate: 30 })`. The exact spelling of the quality
option needs confirming against the installed version at implementation time: mediabunny's
README shows `bitrate: new Quality('high')` while its guide shows
`quality: new Quality({ bitrate: 1e6 })`. Do not guess, read the types.

**Audio for MP4.** Feature-detect with `canEncodeAudio('aac')` and call `registerAacEncoder()`
from `@mediabunny/aac-encoder` when native support is missing. The path for reading decoded
audio out of the input and into an output audio source is the one API detail still to be
settled during implementation; the candidates are an audio sink feeding `AudioBufferSource`, or
running mediabunny's own `Conversion` for the audio track alone. Settle it by reading the
types, not by guessing.

**GIF.** gifenc, palette quantised per export, 12fps. GIF is 256 colours, so a truecolor ASCII
frame will dither visibly. Mono mode is a single hue and will quantise cleanly, which is worth
noting in the UI copy if it looks bad in practice.

**PNG and `.txt`.** PNG stays as it is, `canvas.toBlob`. The text file is `toPlainText(rows)`
from the existing library, written as `text/plain`.

## Error handling

The real boundaries are the source file, which is arbitrary user input, and browser capability.
Calls between our own modules are trusted and not defensively revalidated.

- **Undecodable source or no video track**, via `await videoTrack.canDecode()`: notice, export
  disabled.
- **No H.264 encoder**, via `canEncodeVideo('avc')`: MP4 disabled with a notice, GIF still
  offered. This mirrors the notice already in the file for a browser that will not record a
  canvas.
- **No AAC encoder even with the extension**: MP4 exports silent, with a notice.
- **Cancel**: the generator checks an abort flag between frames, disposes the `Input` and
  discards partial output. The same path runs on unmount during an export, or the decoder
  leaks.
- **GIF size**: a live estimate as in and out move, and a refusal above a ceiling rather than a
  frozen tab. The ceiling starts at 25MB estimated, chosen to sit beside the existing
  `CAST_BYTE_LIMIT` of 24MB, which guards `.cast` the same way. It is a starting value to be
  revised once real exports have been measured, not a derived constant.
- **Anything else**, including an encoder throwing mid-run, surfaces as a notice carrying the
  error's own message with partial output discarded. Not swallowed.

## Testing

**Unit, vitest, beside the existing `lib/ascii.test.ts`.** The pure arithmetic is where the
real bugs will be: frame count for a given in/out and frame rate, the speed multiplication,
out before in, a range shorter than a single frame, the last frame not overshooting out, and
the size estimate with its GIF ceiling decision.

**Not unit tested: the renderer extraction.** It is canvas bound. This project already learned
that the hard way, and the development log states it plainly: unit tests cover the maths and
cannot see a canvas.

**End to end, Playwright, already wired into CI.** The parts only a browser can prove:

- Export roughly one second of MP4 and assert the downloaded bytes carry an `ftyp` box at
  offset 4.
- Export a GIF and assert the `GIF89a` signature.
- Progress appears, then the panel returns to idle.
- A cancelled export produces no download and leaves the panel idle.
- Drop an image, assert the transport is absent and that PNG and `.txt` are offered.

Magic bytes rather than merely asserting a file appeared, because a truncated or empty file
passes the weaker assertion.

## Implementation order

1. Extract `lib/render-frame.ts`. A pure refactor with no behaviour change, verified green by
   the existing e2e suite before any export code exists.
2. The source discriminated union, still video only. Also a refactor.
3. `lib/export/timeline.ts`, written test first.
4. In and out markers on the transport.
5. `lib/export/frames.ts`, then `mp4.ts` without audio, then `gif.ts`.
6. MP4 audio, with its feature detection and fallbacks.
7. `ExportPanel.tsx`, replacing the WebM and recording UI. Delete the `MediaRecorder` path here.
8. Image input, the `.txt` export, and hiding the video-only controls.

Steps 1 and 2 are behaviour preserving and should land and stay green before anything visible
is built on them.

## Out of scope

No output size presets, no frame rate or dithering controls, no in-browser preview of the
finished file, and nothing server side. The app stays fully static, which was a deliberate
property: dropping server-side YouTube resolution is what made it static, and that is worth
keeping.

## Open risks

- **Encode speed.** Five seconds at 30fps is 150 decode, render and encode cycles. Expected to
  take a few seconds, which is exactly why progress and cancel are in scope rather than
  optional.
- **Bundle size.** Mitigated by dynamic import, but worth measuring once rather than assuming.
- **GIF quality on truecolor ASCII.** 256 colours may look poor. Measure before adding controls
  for it, following the log's own lesson about checking the input's statistics before changing
  the renderer.
