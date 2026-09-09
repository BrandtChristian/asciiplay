"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildCastFile,
  CHARSET_PRESETS,
  encodeAnsi,
  toPlainText,
  type CastFrame,
  type CharsetName,
  type Layout,
  type RenderMode,
} from "@/lib/ascii";
import { audioAvailability } from "@/lib/export/audio";
import { renderRange, type ExportedFrame, type FrameSource } from "@/lib/export/frames";
import { encodeGif } from "@/lib/export/gif";
import { canEncodeMp4, encodeMp4 } from "@/lib/export/mp4";
import {
  estimatedBytes,
  exceedsCeiling,
  fpsFor,
  frameTimestamps,
  type ExportFormat,
  type Range,
} from "@/lib/export/timeline";
import { MONO_INKS, monoTreatment, type MonoInk } from "@/lib/mono";
import {
  cellWidthFor,
  createFrameCanvases,
  pixelSizeFor,
  renderFrame,
  type FrameCanvases,
} from "@/lib/render-frame";

const CLIPS = [
  { src: "/clips/big-buck-bunny.mp4", label: "big-buck-bunny.mp4" },
  { src: "/clips/mandelbrot.mp4", label: "mandelbrot.mp4" },
] as const;

/**
 * The mode row, flattened. Mono appears three times because the ink is a separate axis from
 * the mode, and a row of five buttons is a better control than a mode plus a sub-toggle.
 */
const MODE_CHOICES: { label: string; mode: RenderMode; ink?: MonoInk }[] = [
  { label: "colour", mode: "colour" },
  ...MONO_INKS.map((ink) => ({ label: monoTreatment(ink).label, mode: "mono" as const, ink })),
  { label: "blocks", mode: "blocks" },
];

/** Recording accumulates ANSI text, so it needs a ceiling or a long session eats the tab. */
const CAST_BYTE_LIMIT = 24 * 1024 * 1024;

const BYTES_PER_MB = 1024 * 1024;

/**
 * Passes frames through unchanged while counting them. renderRange is a generator, so it cannot
 * both yield frames and hand back how many of the requested timestamps actually produced one; the
 * caller already knows how many it asked for, so it is simpler for the caller to count what it
 * received and compare, than for the generator to report on itself.
 */
async function* countedFrames(
  frames: AsyncIterable<ExportedFrame>,
  received: { count: number },
): AsyncGenerator<ExportedFrame> {
  for await (const frame of frames) {
    received.count += 1;
    yield frame;
  }
}

export default function AsciiPlayer() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const displayRef = useRef<HTMLCanvasElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);

  // Offscreen scratch, created once and resized in place rather than reallocated per frame.
  const canvasesRef = useRef<FrameCanvases | null>(null);

  const layoutRef = useRef<Layout | null>(null);
  const rowsRef = useRef<string[]>([]);
  const castRef = useRef<CastFrame[]>([]);
  const castBytesRef = useRef(0);
  const recordStartRef = useRef(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const webmChunksRef = useRef<Blob[]>([]);
  const fpsWindowRef = useRef({ frames: 0, since: 0 });
  // Mirrors `grid` state outside React. The rAF loop below is set up once in a [] effect, so
  // reading `grid` state from inside it would always see its initial value; this ref is what
  // makes the comparison against the latest layout actually work across frames. Carries
  // cellWidth alongside columns/rows so the live size estimate can read pixel dimensions from
  // state rather than reaching into a ref during render, which react-hooks/refs forbids.
  const gridRef = useRef({ columns: 0, rows: 0, cellWidth: 0 });

  const [source, setSource] = useState<{ src: string; label: string; file?: File }>(CLIPS[0]);
  const [mode, setMode] = useState<RenderMode>("colour");
  const [monoInk, setMonoInk] = useState<MonoInk>("amber");
  const [charset, setCharset] = useState<CharsetName>("ascii");
  const [columns, setColumns] = useState(110);
  const [speed, setSpeed] = useState(1);
  const [muted, setMuted] = useState(true);
  const [recording, setRecording] = useState(false);
  const [measuredFps, setMeasuredFps] = useState(0);
  const [grid, setGrid] = useState({ columns: 0, rows: 0, cellWidth: 0 });
  const [webmUrl, setWebmUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [playing, setPlaying] = useState(true);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [draggingOver, setDraggingOver] = useState(false);
  const [range, setRange] = useState<Range>({ inSeconds: 0, outSeconds: 0 });
  const [format, setFormat] = useState<ExportFormat>("mp4");
  // Assumed supported until the check resolves, so the common case (a browser that can encode
  // H.264) never flashes a disabled button while waiting on an async capability probe.
  const [mp4Supported, setMp4Supported] = useState(true);

  // An unset out point means "to the end", which is what a freshly loaded clip should offer.
  // Memoized so it has a stable identity across renders: exportVideo's useCallback depends on
  // it, and a fresh object every render would defeat that memoization.
  const effectiveRange: Range = useMemo(
    () => ({
      inSeconds: range.inSeconds,
      outSeconds: range.outSeconds > range.inSeconds ? range.outSeconds : duration,
    }),
    [range, duration],
  );

  // Live readout of what exporting the marked range would cost, so the ceiling refusal in
  // exportVideo is never the first time the user hears about the size. Pixel dimensions, not
  // cell counts: GIF bytes track output pixel area, and the columns control barely moves that
  // (see GIF_BYTES_PER_PIXEL's comment in timeline.ts for how a cell-based model got this wrong).
  const exportEstimate = useMemo(() => {
    const frameCount = frameTimestamps({ ...effectiveRange, fps: fpsFor(format), speed }).length;
    const { width, height } = pixelSizeFor(grid.columns, grid.rows, grid.cellWidth);
    return estimatedBytes(format, frameCount, width, height);
  }, [effectiveRange, format, speed, grid]);

  // A range from the previous clip should not survive into the next one. Adjusted during
  // render, following React's own pattern for this, rather than in an effect: setting state
  // unconditionally from an effect body causes an extra committed render every time source
  // merely re-renders for unrelated reasons, which react-hooks/set-state-in-effect flags.
  const [previousSource, setPreviousSource] = useState(source);
  if (previousSource !== source) {
    setPreviousSource(source);
    setRange({ inSeconds: 0, outSeconds: 0 });
  }

  // This project ships no WebM fallback, so a browser that cannot encode H.264 must land on
  // GIF rather than leave the format stuck on a disabled MP4 button. Same during-render pattern
  // as the reset above, and self-limiting: once format is "gif" the condition is false.
  if (!mp4Supported && format === "mp4") setFormat("gif");

  // The loop reads these through a ref so that changing a control never restarts it, and the
  // ref is written from an effect rather than during render.
  const settingsRef = useRef({ mode, charset, columns, recording, monoInk });
  useEffect(() => {
    settingsRef.current = { mode, charset, columns, recording, monoInk };
  }, [mode, charset, columns, recording, monoInk]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) video.playbackRate = speed;
  }, [speed]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) video.muted = muted;
  }, [muted]);

  useEffect(() => {
    let cancelled = false;
    void canEncodeMp4().then((supported) => {
      if (!cancelled) setMp4Supported(supported);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => setPosition(video.currentTime);
    const onLoaded = () => setDuration(Number.isFinite(video.duration) ? video.duration : 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    // HAVE_METADATA or better means these events may already have fired, before this effect
    // had a chance to subscribe, so read the current state as well as listening for changes.
    if (video.readyState >= 1) onLoaded();
    setPlaying(!video.paused);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("loadedmetadata", onLoaded);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    return () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
    };
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  }, []);

  const seekTo = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (video) video.currentTime = seconds;
  }, []);

  // Space is the expected key for this, but not while a control has focus, where it belongs to
  // the button or slider the user is actually operating.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      const active = document.activeElement;
      if (active instanceof HTMLButtonElement || active instanceof HTMLInputElement) return;
      event.preventDefault();
      togglePlay();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePlay]);

  useEffect(() => {
    let handle = 0;

    const tick = (timestamp: number) => {
      handle = requestAnimationFrame(tick);

      const video = videoRef.current;
      const display = displayRef.current;
      const shell = shellRef.current;
      if (!video || !display || !shell) return;
      // HAVE_CURRENT_DATA: below this there is no frame to sample yet.
      if (video.readyState < 2 || !video.videoWidth) return;

      const { mode, charset, columns, recording, monoInk } = settingsRef.current;
      if (!canvasesRef.current) canvasesRef.current = createFrameCanvases(display);

      // Same value exportVideo recomputes at click time from the same inputs (shell width,
      // columns), so mirroring it here keeps the live estimate honest without touching a ref
      // during render.
      const cellWidth = cellWidthFor(shell.clientWidth, columns);
      const frame = renderFrame(canvasesRef.current, {
        source: video,
        sourceWidth: video.videoWidth,
        sourceHeight: video.videoHeight,
        mode,
        monoInk,
        charsetRamp: CHARSET_PRESETS[charset],
        columns,
        cellWidth,
        pixelRatio: window.devicePixelRatio || 1,
      });
      if (!frame) return;
      layoutRef.current = frame.layout;
      rowsRef.current = frame.rows;
      display.style.width = `${frame.cssWidth}px`;
      display.style.height = `${frame.cssHeight}px`;
      if (
        gridRef.current.columns !== frame.layout.cellColumns ||
        gridRef.current.rows !== frame.layout.cellRows ||
        gridRef.current.cellWidth !== cellWidth
      ) {
        gridRef.current = {
          columns: frame.layout.cellColumns,
          rows: frame.layout.cellRows,
          cellWidth,
        };
        setGrid(gridRef.current);
      }

      if (recording && castBytesRef.current < CAST_BYTE_LIMIT) {
        const data = encodeAnsi(frame.pixels, frame.layout, mode, frame.ramp);
        castBytesRef.current += data.length;
        castRef.current.push({
          time: (timestamp - recordStartRef.current) / 1000,
          data,
        });
      }

      const window_ = fpsWindowRef.current;
      window_.frames += 1;
      if (timestamp - window_.since >= 500) {
        setMeasuredFps((window_.frames * 1000) / (timestamp - window_.since));
        window_.frames = 0;
        window_.since = timestamp;
      }
    };

    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, []);

  const startRecording = useCallback(() => {
    const display = displayRef.current;
    const video = videoRef.current;
    if (!display) return;
    castRef.current = [];
    castBytesRef.current = 0;
    recordStartRef.current = performance.now();
    webmChunksRef.current = [];
    setWebmUrl(null);

    try {
      const stream = display.captureStream(30);
      if (video && !video.muted) {
        // captureStream on a media element is not universally available, so audio is a bonus
        // rather than a requirement.
        const withAudio = (
          video as HTMLVideoElement & {
            captureStream?: () => MediaStream;
          }
        ).captureStream?.();
        withAudio?.getAudioTracks().forEach((track) => stream.addTrack(track));
      }
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) webmChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(webmChunksRef.current, { type: "video/webm" });
        setWebmUrl(URL.createObjectURL(blob));
      };
      recorder.start();
      recorderRef.current = recorder;
    } catch {
      setNotice("this browser will not record the canvas, but .cast still works");
    }
    setRecording(true);
  }, []);

  const stopRecording = useCallback(() => {
    setRecording(false);
    recorderRef.current?.stop();
    recorderRef.current = null;
  }, []);

  const download = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }, []);

  const downloadCast = useCallback(() => {
    const layout = layoutRef.current;
    if (!layout || castRef.current.length === 0) {
      setNotice("record something first");
      return;
    }
    const cast = buildCastFile(castRef.current, layout, source.label);
    download(new Blob([cast], { type: "application/x-asciicast" }), "asciiplay.cast");
  }, [download, source.label]);

  const downloadPng = useCallback(() => {
    displayRef.current?.toBlob((blob) => {
      if (blob) download(blob, "asciiplay.png");
    });
  }, [download]);

  const copyText = useCallback(async () => {
    if (rowsRef.current.length === 0) {
      setNotice("blocks mode paints pixels, not text. Switch to ascii or mono to copy");
      return;
    }
    await navigator.clipboard.writeText(toPlainText(rowsRef.current));
    setNotice("frame copied as text");
  }, []);

  const openFile = useCallback((file: File) => {
    setSource({ src: URL.createObjectURL(file), label: file.name, file });
    setNotice(null);
  }, []);

  const exportVideo = useCallback(async () => {
    const layout = layoutRef.current;
    if (!layout) return;
    const fps = fpsFor(format);
    const timestamps = frameTimestamps({ ...effectiveRange, fps, speed });
    const cellWidth = cellWidthFor(shellRef.current!.clientWidth, columns);
    const { width, height } = pixelSizeFor(layout.cellColumns, layout.cellRows, cellWidth);

    if (exceedsCeiling(format, estimatedBytes(format, timestamps.length, width, height))) {
      setNotice(
        "that range would make a GIF too big to build here. Shorten it or narrow the width",
      );
      return;
    }

    const frameSource: FrameSource = { url: source.src, file: source.file };
    const frames = renderRange(
      frameSource,
      timestamps,
      { mode, monoInk, charsetRamp: CHARSET_PRESETS[charset], columns, cellWidth },
      new AbortController().signal,
    );
    const received = { count: 0 };
    try {
      let blob: Blob;
      if (format === "mp4") {
        // Mute is a preview control, not an export setting: the export carries audio whenever
        // the browser can produce it, regardless of whether the live preview is muted.
        let audio: { source: FrameSource; range: Range } | null = null;
        try {
          const availability = await audioAvailability(frameSource, speed);
          if (availability.kind === "unavailable") setNotice(availability.reason);
          else audio = { source: frameSource, range: effectiveRange };
        } catch {
          // Probing audio is a bonus on top of the video export; a failure here should not
          // sink an otherwise working export, it should just leave the file silent.
        }
        blob = await encodeMp4(countedFrames(frames, received), { fps, width, height, audio });
      } else {
        blob = await encodeGif(countedFrames(frames, received), { fps, width, height });
      }
      download(blob, `asciiplay.${format}`);
      // A range only partly overlapping the available video (this clip's lead-in again, but
      // straddled rather than fully inside it) still produces a clean, playable file, just a
      // shorter one starting later than marked. That is worth disclosing even though it is not
      // worth refusing: the marked range itself is a UI concern outside this task's scope.
      if (received.count < timestamps.length) {
        setNotice(
          `exported ${received.count} of ${timestamps.length} frames, the rest of that range has no video`,
        );
      }
    } catch (error) {
      // Reachable, not theoretical: any marked range inside this clip's audio-only lead-in has
      // no video sample at all, and renderRange throws for exactly that rather than letting the
      // encoder hand back a silently empty file.
      setNotice(error instanceof Error ? error.message : "export failed");
    }
  }, [charset, columns, download, effectiveRange, format, mode, monoInk, source, speed]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  return (
    <div className="player">
      <div
        className="screen"
        ref={shellRef}
        onDragOver={(event) => {
          event.preventDefault();
          setDraggingOver(true);
        }}
        onDragLeave={() => setDraggingOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDraggingOver(false);
          const file = event.dataTransfer.files[0];
          if (file?.type.startsWith("video/")) openFile(file);
          else setNotice("that was not a video file");
        }}
      >
        <canvas ref={displayRef} className="output" />
        {/* Paper does not have scanlines, and a multiply overlay on white is grey banding. */}
        {!(mode === "mono" && monoTreatment(monoInk).paper) && (
          <div className="scanlines" aria-hidden="true" />
        )}
        {draggingOver ? <div className="drop-hint">drop to play it here</div> : null}
        <video
          ref={videoRef}
          src={source.src}
          className="hidden-video"
          autoPlay
          loop
          muted={muted}
          playsInline
          crossOrigin="anonymous"
        />
      </div>

      <div className="readout">
        <span>
          {grid.columns}x{grid.rows} cells
        </span>
        <span>{measuredFps.toFixed(0)} fps</span>
        <span className="dim">{source.label}</span>
        {recording ? <span className="recording">recording</span> : null}
        {notice ? <span className="notice">{notice}</span> : null}
      </div>

      <div className="transport">
        <button
          type="button"
          className="transport-play"
          onClick={togglePlay}
          aria-label={playing ? "pause" : "play"}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <input
          type="range"
          className="seek"
          min={0}
          max={duration || 0}
          step={0.02}
          value={Math.min(position, duration || 0)}
          onChange={(event) => seekTo(Number(event.target.value))}
          aria-label="position"
        />
        <span className="clock">
          {formatClock(position)} / {formatClock(duration)}
        </span>
      </div>

      <div className="range">
        <button type="button" onClick={() => setRange((r) => ({ ...r, inSeconds: position }))}>
          set in
        </button>
        <button type="button" onClick={() => setRange((r) => ({ ...r, outSeconds: position }))}>
          set out
        </button>
        <span className="range-readout">
          in {formatClock(effectiveRange.inSeconds)} out {formatClock(effectiveRange.outSeconds)}
        </span>
        <button type="button" onClick={() => setRange({ inSeconds: 0, outSeconds: 0 })}>
          clear
        </button>
      </div>

      <div className="controls">
        <fieldset>
          <legend>mode</legend>
          {MODE_CHOICES.map((choice) => (
            <button
              key={choice.label}
              type="button"
              aria-pressed={mode === choice.mode && (!choice.ink || monoInk === choice.ink)}
              onClick={() => {
                setMode(choice.mode);
                if (choice.ink) setMonoInk(choice.ink);
              }}
            >
              {choice.label}
            </button>
          ))}
        </fieldset>

        <fieldset>
          <legend>charset</legend>
          {(Object.keys(CHARSET_PRESETS) as CharsetName[]).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={charset === option}
              disabled={mode === "blocks"}
              onClick={() => setCharset(option)}
            >
              {option}
            </button>
          ))}
        </fieldset>

        <fieldset>
          <legend>width {columns}</legend>
          <input
            type="range"
            min={40}
            max={220}
            step={2}
            value={columns}
            onChange={(event) => setColumns(Number(event.target.value))}
            aria-label="columns"
          />
        </fieldset>

        <fieldset>
          <legend>speed {speed.toFixed(2)}x</legend>
          <input
            type="range"
            min={0.25}
            max={2}
            step={0.05}
            value={speed}
            onChange={(event) => setSpeed(Number(event.target.value))}
            aria-label="speed"
          />
        </fieldset>

        <fieldset>
          <legend>sound</legend>
          <button type="button" aria-pressed={!muted} onClick={() => setMuted((on) => !on)}>
            {muted ? "off" : "on"}
          </button>
        </fieldset>

        <fieldset className="source">
          <legend>clip</legend>
          {CLIPS.map((clip) => (
            <button
              key={clip.src}
              type="button"
              aria-pressed={source.src === clip.src}
              onClick={() => setSource(clip)}
            >
              {clip.label.replace(".mp4", "")}
            </button>
          ))}
          <label className="file">
            try your own video
            <input
              type="file"
              accept="video/*"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) openFile(file);
              }}
            />
          </label>
          <span className="hint">or drop one on the screen. it stays on your machine.</span>
        </fieldset>

        <fieldset>
          <legend>format</legend>
          <button
            type="button"
            aria-pressed={format === "mp4"}
            disabled={!mp4Supported}
            onClick={() => setFormat("mp4")}
          >
            mp4
          </button>
          <button type="button" aria-pressed={format === "gif"} onClick={() => setFormat("gif")}>
            gif
          </button>
          <span className="estimate">{formatEstimate(exportEstimate)}</span>
          {!mp4Supported ? (
            <span className="hint">
              this browser cannot encode H.264, so GIF is the only option here
            </span>
          ) : null}
        </fieldset>

        <fieldset>
          <legend>export</legend>
          <button type="button" onClick={recording ? stopRecording : startRecording}>
            {recording ? "stop" : "record"}
          </button>
          <button type="button" onClick={downloadPng}>
            png
          </button>
          <button type="button" onClick={copyText}>
            copy
          </button>
          <button type="button" onClick={downloadCast}>
            .cast
          </button>
          <button type="button" onClick={() => void exportVideo()}>
            export {format}
          </button>
          {webmUrl ? (
            <a href={webmUrl} download="asciiplay.webm" className="ready">
              webm ready
            </a>
          ) : null}
        </fieldset>
      </div>
    </div>
  );
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

// Rounding a sub-1MB estimate to whole megabytes reads as "~0MB", which tells the user an
// export is free when it is not. KB below the threshold instead, so a real file never rounds
// away to nothing.
function formatEstimate(bytes: number): string {
  if (bytes < BYTES_PER_MB) return `~${Math.round(bytes / 1024)}KB`;
  return `~${Math.round(bytes / BYTES_PER_MB)}MB`;
}
