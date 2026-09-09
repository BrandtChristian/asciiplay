"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { MONO_INKS, monoTreatment, type MonoInk } from "@/lib/mono";
import {
  cellWidthFor,
  createFrameCanvases,
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
  // makes the comparison against the latest layout actually work across frames.
  const gridRef = useRef({ columns: 0, rows: 0 });

  const [source, setSource] = useState<{ src: string; label: string }>(CLIPS[0]);
  const [mode, setMode] = useState<RenderMode>("colour");
  const [monoInk, setMonoInk] = useState<MonoInk>("amber");
  const [charset, setCharset] = useState<CharsetName>("ascii");
  const [columns, setColumns] = useState(110);
  const [speed, setSpeed] = useState(1);
  const [muted, setMuted] = useState(true);
  const [recording, setRecording] = useState(false);
  const [measuredFps, setMeasuredFps] = useState(0);
  const [grid, setGrid] = useState({ columns: 0, rows: 0 });
  const [webmUrl, setWebmUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [playing, setPlaying] = useState(true);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [draggingOver, setDraggingOver] = useState(false);

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

      const frame = renderFrame(canvasesRef.current, {
        source: video,
        sourceWidth: video.videoWidth,
        sourceHeight: video.videoHeight,
        mode,
        monoInk,
        charsetRamp: CHARSET_PRESETS[charset],
        columns,
        cellWidth: cellWidthFor(shell.clientWidth, columns),
        pixelRatio: window.devicePixelRatio || 1,
      });
      if (!frame) return;
      layoutRef.current = frame.layout;
      rowsRef.current = frame.rows;
      display.style.width = `${frame.cssWidth}px`;
      display.style.height = `${frame.cssHeight}px`;
      if (
        gridRef.current.columns !== frame.layout.cellColumns ||
        gridRef.current.rows !== frame.layout.cellRows
      ) {
        gridRef.current = { columns: frame.layout.cellColumns, rows: frame.layout.cellRows };
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
    setSource({ src: URL.createObjectURL(file), label: file.name });
    setNotice(null);
  }, []);

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
