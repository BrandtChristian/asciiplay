# Offline MP4 and GIF Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the web player's realtime WebM capture with a deterministic offline export pass that renders a marked range to MP4 or GIF at a fixed frame rate.

**Architecture:** The renderer moves out of the `requestAnimationFrame` loop into `lib/render-frame.ts`, so it can be driven by decoded video samples instead of a `<video>` element. Export then becomes: build an exact timestamp list from the in and out markers, pull those samples with mediabunny, render each one, feed the results to either mediabunny's MP4 muxer or gifenc.

**Tech Stack:** Next.js 16.3.4, React 19, TypeScript, Bun, Vitest, Playwright, mediabunny, gifenc.

**Spec:** `docs/superpowers/specs/2026-09-09-web-export-and-image-input-design.md`

## Global Constraints

- All work happens in `web/`. Run every command from `web/`.
- TypeScript only. Never introduce a `.js` file.
- Package manager is Bun. The repo has `bun.lock`; use `bun add`, never npm.
- `lib/ascii.ts` must not change. If a task seems to need it changed, stop and ask.
- MP4 is 30fps. GIF is 12fps. These are constants, not user controls.
- Export renders at `pixelRatio` 1, never `devicePixelRatio`.
- GIF estimated-size ceiling starts at 25MB (`25 * 1024 * 1024`).
- Frame timestamps honour the speed control. When speed is not exactly 1, the MP4 is silent.
- No WebM output and no WebM fallback. A browser that cannot encode `avc` is offered GIF only, with a notice.
- Both new dependencies are loaded with dynamic `import()` inside the export path, never imported at module top level, so the initial page load does not carry an encoder.
- Never use em dashes or en dashes in code comments, commit messages or docs. Use a comma, colon, parentheses, or split the sentence.
- Gates before every commit, all from `web/`: `bun run typecheck`, `bun run lint`, `bun run test`, `bun run format:check`. Run `bun run format` to fix formatting.
- Do not run `bun run e2e` inside a Claude Code session without capturing output to a file; it builds and starts a server. It is fine to run, just expect roughly 30 seconds of build.

---

### Task 1: Extract the frame renderer out of the render loop

Pure refactor. No behaviour change. The existing e2e suite is the safety net; the one new unit test covers the pure sizing rule that export will depend on.

**Files:**
- Create: `web/lib/render-frame.ts`
- Create: `web/lib/render-frame.test.ts`
- Modify: `web/components/AsciiPlayer.tsx` (delete the inline drawing block, currently lines 175 to 250, and call the new module instead)

**Interfaces:**
- Consumes: `lib/ascii.ts` (`fitLayout`, `buildGlyphRows`, `type Layout`, `type RenderMode`), `lib/mono.ts` (`monoTreatment`, `rampForInk`, `type MonoInk`)
- Produces:
  ```ts
  export interface FrameCanvases {
    display: HTMLCanvasElement;
    glyph: HTMLCanvasElement;
    sample: HTMLCanvasElement;
  }
  export function createFrameCanvases(display: HTMLCanvasElement): FrameCanvases;
  export function cellWidthFor(availableWidth: number, columns: number): number;
  export interface RenderRequest {
    source: CanvasImageSource;
    sourceWidth: number;
    sourceHeight: number;
    mode: RenderMode;
    monoInk: MonoInk;
    charsetRamp: string;
    columns: number;
    cellWidth: number;
    pixelRatio: number;
  }
  export interface RenderedFrame {
    layout: Layout;
    rows: string[];
    pixels: Uint8ClampedArray;
    ramp: string;
    cssWidth: number;
    cssHeight: number;
  }
  export function renderFrame(
    canvases: FrameCanvases,
    request: RenderRequest,
  ): RenderedFrame | null;
  ```

- [ ] **Step 1: Write the failing test**

Create `web/lib/render-frame.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { cellWidthFor } from "./render-frame";

describe("cellWidthFor", () => {
  it("gives a whole number of pixels per cell", () => {
    // A fractional cell width desynchronises a row drawn with one fillText from the colour
    // grid it is multiplied against, which shears the picture.
    expect(cellWidthFor(1100, 110)).toBe(10);
    expect(cellWidthFor(1105, 110)).toBe(10);
    expect(Number.isInteger(cellWidthFor(999, 97))).toBe(true);
  });

  it("never goes below three pixels, however narrow the shell", () => {
    expect(cellWidthFor(100, 110)).toBe(3);
    expect(cellWidthFor(0, 110)).toBe(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test`
Expected: FAIL with `Cannot find module './render-frame'`.

- [ ] **Step 3: Create the module with the pure helper only**

Create `web/lib/render-frame.ts`:

```ts
import { buildGlyphRows, fitLayout, type Layout, type RenderMode } from "./ascii";
import { monoTreatment, rampForInk, type MonoInk } from "./mono";

/** Below this a cell is not a glyph any more, and the font size collapses. */
const MINIMUM_CELL_WIDTH = 3;

/**
 * Cell width in whole pixels.
 *
 * Whole pixels are not a nicety: the glyph advance has to equal the cell width exactly, or a
 * row drawn with a single fillText drifts out of step with the colour grid it is multiplied
 * against, and the picture shears further to the right on every column.
 */
export function cellWidthFor(availableWidth: number, columns: number): number {
  return Math.max(MINIMUM_CELL_WIDTH, Math.floor(availableWidth / columns));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test`
Expected: PASS, 27 tests total.

- [ ] **Step 5: Move the rest of the renderer into the module**

Append to `web/lib/render-frame.ts`. This is the block currently inside the rAF loop in `AsciiPlayer.tsx`, with `video` replaced by `request.source` and the measured width replaced by `request.cellWidth`. Copy the existing comments across; they explain why the composite works.

```ts
export interface FrameCanvases {
  display: HTMLCanvasElement;
  glyph: HTMLCanvasElement;
  sample: HTMLCanvasElement;
}

export function createFrameCanvases(display: HTMLCanvasElement): FrameCanvases {
  return {
    display,
    glyph: document.createElement("canvas"),
    sample: document.createElement("canvas"),
  };
}

export interface RenderRequest {
  source: CanvasImageSource;
  sourceWidth: number;
  sourceHeight: number;
  mode: RenderMode;
  monoInk: MonoInk;
  charsetRamp: string;
  columns: number;
  /** Device pixels per cell. The preview scales by devicePixelRatio; export passes 1. */
  cellWidth: number;
  pixelRatio: number;
}

export interface RenderedFrame {
  layout: Layout;
  rows: string[];
  pixels: Uint8ClampedArray;
  /** The effective ramp, reversed for reverse ink, so encodeAnsi agrees with the canvas. */
  ramp: string;
  cssWidth: number;
  cssHeight: number;
}

export function renderFrame(
  canvases: FrameCanvases,
  request: RenderRequest,
): RenderedFrame | null {
  const { display, glyph, sample } = canvases;
  const displayContext = display.getContext("2d");
  const sampleContext = sample.getContext("2d", { willReadFrequently: true });
  const glyphContext = glyph.getContext("2d");
  if (!displayContext || !sampleContext || !glyphContext) return null;

  const { mode, monoInk, columns, cellWidth, pixelRatio } = request;
  const treatment = monoTreatment(monoInk);
  const ramp = mode === "mono" ? rampForInk(request.charsetRamp, monoInk) : request.charsetRamp;

  const cellHeight = cellWidth * 2;
  const layout = fitLayout(columns, request.sourceWidth, request.sourceHeight, mode);
  const cssWidth = layout.cellColumns * cellWidth;
  const cssHeight = layout.cellRows * cellHeight;

  displayContext.font = `100px ui-monospace, monospace`;
  const advanceRatio = displayContext.measureText("M").width / 100;
  const fontSize = cellWidth / advanceRatio;

  if (display.width !== cssWidth * pixelRatio || display.height !== cssHeight * pixelRatio) {
    for (const canvas of [display, glyph]) {
      canvas.width = cssWidth * pixelRatio;
      canvas.height = cssHeight * pixelRatio;
    }
  }
  if (sample.width !== layout.pixelWidth || sample.height !== layout.pixelHeight) {
    sample.width = layout.pixelWidth;
    sample.height = layout.pixelHeight;
  }

  // One cell per pixel: the browser's own scaler does the downscaling for free.
  sampleContext.drawImage(request.source, 0, 0, layout.pixelWidth, layout.pixelHeight);
  const pixels = sampleContext.getImageData(0, 0, layout.pixelWidth, layout.pixelHeight).data;

  displayContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  displayContext.globalCompositeOperation = "source-over";
  displayContext.fillStyle = mode === "mono" ? treatment.ground : "#000";
  displayContext.fillRect(0, 0, cssWidth, cssHeight);

  let rows: string[] = [];
  if (mode === "blocks") {
    // Half blocks are just the cell grid at double vertical resolution, so nearest neighbour
    // upscaling of the sample IS the mode. No glyphs involved.
    displayContext.imageSmoothingEnabled = false;
    displayContext.drawImage(sample, 0, 0, cssWidth, cssHeight);
  } else {
    rows = buildGlyphRows(pixels, layout, mode, ramp);
    const target = mode === "mono" ? displayContext : glyphContext;
    if (mode !== "mono") {
      glyphContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      glyphContext.fillStyle = "#000";
      glyphContext.fillRect(0, 0, cssWidth, cssHeight);
    }
    target.font = `${fontSize}px ui-monospace, monospace`;
    target.textBaseline = "middle";
    target.fillStyle = mode === "mono" ? treatment.glyph : "#fff";
    for (let row = 0; row < rows.length; row += 1) {
      // One call per row rather than per cell: about 40 draws a frame instead of 4000.
      target.fillText(rows[row], 0, row * cellHeight + cellHeight / 2);
    }
    if (mode !== "mono") {
      // White glyphs times the per-cell colour field gives glyph shaped colour, and needs one
      // composite rather than a fillStyle change per run.
      displayContext.drawImage(glyph, 0, 0, cssWidth, cssHeight);
      displayContext.globalCompositeOperation = "multiply";
      displayContext.imageSmoothingEnabled = false;
      displayContext.drawImage(sample, 0, 0, cssWidth, cssHeight);
      displayContext.globalCompositeOperation = "source-over";
    }
  }

  return { layout, rows, pixels, ramp, cssWidth, cssHeight };
}
```

- [ ] **Step 6: Rewire the component to call it**

In `AsciiPlayer.tsx`: delete `measureMetrics` and the whole drawing block inside `tick`, keep the guards and the `.cast` accumulation, and replace the middle with:

```ts
const frame = renderFrame(canvasesRef.current!, {
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
if (grid.columns !== frame.layout.cellColumns || grid.rows !== frame.layout.cellRows) {
  setGrid({ columns: frame.layout.cellColumns, rows: frame.layout.cellRows });
}
```

Replace `sampleRef` and `glyphRef` with a single `canvasesRef`, initialised lazily from `createFrameCanvases(display)`. The `.cast` block now reads `frame.pixels` and `frame.ramp` rather than recomputing the ramp.

- [ ] **Step 7: Run the unit gates**

Run: `bun run typecheck && bun run lint && bun run test && bun run format:check`
Expected: all pass, 27 tests.

- [ ] **Step 8: Run the e2e suite, which is the actual refactor net**

Run: `bun run e2e 2>&1 | tail -20`
Expected: 7 passed. If any fail, the extraction changed behaviour; fix the extraction, not the test.

- [ ] **Step 9: Commit**

```bash
git add web/lib/render-frame.ts web/lib/render-frame.test.ts web/components/AsciiPlayer.tsx
git commit -m "Web: extract the frame renderer out of the render loop

The renderer was inline in the rAF loop and read the video element
directly, so nothing else could drive it. It now takes any canvas image
source plus its dimensions, which is what lets a decoded sample or a
still image render through exactly the same path.

No behaviour change. The existing e2e suite is the proof."
```

---

### Task 2: The export timeline

Pure arithmetic, no browser APIs, so this is the one part of export that unit tests can fully cover.

**Files:**
- Create: `web/lib/export/timeline.ts`
- Create: `web/lib/export/timeline.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  ```ts
  export type ExportFormat = "mp4" | "gif";
  export interface Range { inSeconds: number; outSeconds: number }
  export interface TimelineRequest extends Range { fps: number; speed: number }
  export const MP4_FPS = 30;
  export const GIF_FPS = 12;
  export const GIF_MAX_BYTES = 25 * 1024 * 1024;
  /** Exported because mp4.ts asks the encoder for it and the estimate assumes it. */
  export const MP4_BITRATE = 2_000_000;
  export function fpsFor(format: ExportFormat): number;
  export function frameTimestamps(request: TimelineRequest): number[];
  export function estimatedBytes(
    format: ExportFormat,
    frameCount: number,
    cellColumns: number,
    cellRows: number,
  ): number;
  export function exceedsCeiling(format: ExportFormat, bytes: number): boolean;
  ```

- [ ] **Step 1: Write the failing test**

Create `web/lib/export/timeline.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  estimatedBytes,
  exceedsCeiling,
  fpsFor,
  frameTimestamps,
  GIF_MAX_BYTES,
} from "./timeline";

describe("frameTimestamps", () => {
  it("covers a one second range at the requested rate", () => {
    const stamps = frameTimestamps({ inSeconds: 0, outSeconds: 1, fps: 30, speed: 1 });
    expect(stamps).toHaveLength(30);
    expect(stamps[0]).toBe(0);
    expect(stamps.at(-1)).toBeCloseTo(29 / 30, 6);
  });

  it("starts at the in point rather than at zero", () => {
    const stamps = frameTimestamps({ inSeconds: 5, outSeconds: 6, fps: 30, speed: 1 });
    expect(stamps[0]).toBe(5);
    expect(stamps.at(-1)).toBeLessThan(6);
  });

  it("walks the source faster when speed is raised, so the output is shorter", () => {
    // Frame i samples in + i * speed / fps, so double speed needs half the frames to cross
    // the same span of source, and the resulting clip plays in half the time.
    const stamps = frameTimestamps({ inSeconds: 0, outSeconds: 1, fps: 30, speed: 2 });
    expect(stamps).toHaveLength(15);
    expect(stamps.at(-1)).toBeCloseTo(28 / 30, 6);
  });

  it("never overshoots the out point", () => {
    const stamps = frameTimestamps({ inSeconds: 0, outSeconds: 0.5, fps: 30, speed: 1 });
    for (const stamp of stamps) expect(stamp).toBeLessThan(0.5);
  });

  it("still yields one frame for a range shorter than a single frame", () => {
    expect(frameTimestamps({ inSeconds: 2, outSeconds: 2.001, fps: 30, speed: 1 })).toEqual([2]);
  });

  it("still yields one frame when out is before in", () => {
    // The panel prevents this, but an empty file is a worse answer than a single frame.
    expect(frameTimestamps({ inSeconds: 4, outSeconds: 1, fps: 30, speed: 1 })).toEqual([4]);
  });
});

describe("fpsFor", () => {
  it("gives GIF a lower rate than MP4, because GIF at 30 is enormous", () => {
    expect(fpsFor("gif")).toBeLessThan(fpsFor("mp4"));
  });
});

describe("estimatedBytes", () => {
  it("grows with the frame count and with the cell grid", () => {
    const small = estimatedBytes("gif", 12, 80, 24);
    expect(estimatedBytes("gif", 24, 80, 24)).toBeGreaterThan(small);
    expect(estimatedBytes("gif", 12, 160, 48)).toBeGreaterThan(small);
  });

  it("puts a long wide GIF over the ceiling and a short one under it", () => {
    expect(exceedsCeiling("gif", estimatedBytes("gif", 12, 80, 24))).toBe(false);
    expect(exceedsCeiling("gif", estimatedBytes("gif", 12 * 600, 220, 80))).toBe(true);
  });

  it("does not cap MP4, which is small enough to leave alone", () => {
    expect(exceedsCeiling("mp4", GIF_MAX_BYTES * 10)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test`
Expected: FAIL with `Cannot find module './timeline'`.

- [ ] **Step 3: Write the implementation**

Create `web/lib/export/timeline.ts`:

```ts
export type ExportFormat = "mp4" | "gif";

export interface Range {
  inSeconds: number;
  outSeconds: number;
}

export interface TimelineRequest extends Range {
  fps: number;
  speed: number;
}

export const MP4_FPS = 30;
/** GIF at 30fps is enormous, and 12 is enough for a clip in a slide. */
export const GIF_FPS = 12;
export const GIF_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Empirical, and deliberately so: a quantised GIF frame of ASCII costs roughly this per cell
 * after LZW, because large flat runs compress hard. Calibrate it against a real export rather
 * than trusting it, and see the note in Task 5.
 */
const GIF_BYTES_PER_CELL = 0.5;
/** Bitrate the MP4 encoder is asked for, so the estimate and the encoder agree. */
export const MP4_BITRATE = 2_000_000;

export function fpsFor(format: ExportFormat): number {
  return format === "mp4" ? MP4_FPS : GIF_FPS;
}

/**
 * Source timestamps for each output frame.
 *
 * Output frame i is shown at i/fps and samples the source at in + i * speed / fps, so the
 * speed control the user already tuned carries into the file rather than being ignored.
 * Always at least one frame: an empty file is a worse answer than a single frame.
 */
export function frameTimestamps(request: TimelineRequest): number[] {
  const { inSeconds, outSeconds, fps, speed } = request;
  const step = speed / fps;
  const span = outSeconds - inSeconds;
  const count = Math.max(1, Math.floor(span / step));
  return Array.from({ length: count }, (_unused, index) => inSeconds + index * step);
}

export function estimatedBytes(
  format: ExportFormat,
  frameCount: number,
  cellColumns: number,
  cellRows: number,
): number {
  if (format === "mp4") {
    return Math.round((frameCount / MP4_FPS) * (MP4_BITRATE / 8));
  }
  return Math.round(frameCount * cellColumns * cellRows * GIF_BYTES_PER_CELL);
}

export function exceedsCeiling(format: ExportFormat, bytes: number): boolean {
  // Only GIF is capped. An MP4 of these dimensions stays small on its own.
  return format === "gif" && bytes > GIF_MAX_BYTES;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test`
Expected: PASS, 37 tests total.

- [ ] **Step 5: Run the remaining gates and commit**

Run: `bun run typecheck && bun run lint && bun run format:check`

```bash
git add web/lib/export/timeline.ts web/lib/export/timeline.test.ts
git commit -m "Web: the export timeline, as pure arithmetic

Output frame i samples the source at in + i * speed / fps, which is how
the speed control reaches the exported file instead of being quietly
dropped. Frame rate is fixed per format because a GIF at 30fps is
enormous.

The size estimate's GIF constant is empirical and flagged as such. It
exists to keep the tab from being asked to build a 400MB GIF, not to
predict a byte count."
```

---

### Task 3: In and out markers on the transport

**Files:**
- Modify: `web/components/AsciiPlayer.tsx`
- Modify: `web/app/globals.css`
- Modify: `web/e2e/player.spec.ts`

**Interfaces:**
- Consumes: `lib/export/timeline.ts` (`type Range`)
- Produces: component state `range: Range`, and a `.range-readout` element whose text is `in 0:02 out 0:07`, which the e2e test and later tasks both read.

- [ ] **Step 1: Write the failing e2e test**

Append to `web/e2e/player.spec.ts`:

```ts
test("in and out markers define a range on the transport", async ({ page }) => {
  await page.goto("/");
  await expect
    .poll(async () => await page.locator(".clock").innerText(), { timeout: 15_000 })
    .not.toBe("0:00 / 0:00");

  await page.locator(".seek").fill("2");
  await page.getByRole("button", { name: "set in", exact: true }).click();
  await page.locator(".seek").fill("7");
  await page.getByRole("button", { name: "set out", exact: true }).click();

  await expect(page.locator(".range-readout")).toContainText("in 0:02");
  await expect(page.locator(".range-readout")).toContainText("out 0:07");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run e2e 2>&1 | tail -20`
Expected: FAIL, waiting for `getByRole('button', { name: 'set in' })`.

- [ ] **Step 3: Add the state and controls**

In `AsciiPlayer.tsx`, beside the existing transport:

```tsx
const [range, setRange] = useState<Range>({ inSeconds: 0, outSeconds: 0 });

// An unset out point means "to the end", which is what a freshly loaded clip should offer.
const effectiveRange: Range = {
  inSeconds: range.inSeconds,
  outSeconds: range.outSeconds > range.inSeconds ? range.outSeconds : duration,
};
```

```tsx
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
```

Reset `range` to `{ inSeconds: 0, outSeconds: 0 }` in the effect that runs when `source` changes, or a range from the previous clip survives into the next one.

- [ ] **Step 4: Draw the selected span on the seek bar**

In `globals.css`, add a `.range` row matching the existing `.controls` fieldset styling, and shade the selected span behind the seek input:

```css
.range {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.range-readout {
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
}
```

Keep it to the readout and buttons. A dragged region on the input is not in scope; the buttons plus the existing seek bar are the whole interaction.

- [ ] **Step 5: Run all gates and the e2e**

Run: `bun run typecheck && bun run lint && bun run test && bun run format:check`
Run: `bun run e2e 2>&1 | tail -20`
Expected: 8 passed.

- [ ] **Step 6: Commit**

```bash
git add web/components/AsciiPlayer.tsx web/app/globals.css web/e2e/player.spec.ts
git commit -m "Web: in and out markers on the transport

Scrub, set in, scrub, set out. An unset out point means the end of the
clip, so a freshly loaded file is immediately exportable without touching
the markers at all."
```

---

### Task 4: Frame extraction and a working silent MP4

The first vertical slice: one button that produces a real file. Audio, progress and cancel come later.

**Files:**
- Create: `web/lib/export/frames.ts`
- Create: `web/lib/export/mp4.ts`
- Modify: `web/components/AsciiPlayer.tsx`
- Modify: `web/e2e/player.spec.ts`

**Interfaces:**
- Consumes: `lib/render-frame.ts` (`renderFrame`, `createFrameCanvases`, `cellWidthFor`), `lib/export/timeline.ts`
- Produces:
  ```ts
  // frames.ts
  export interface FrameSource { url: string; file?: File }
  export interface RenderSettings {
    mode: RenderMode;
    monoInk: MonoInk;
    charsetRamp: string;
    columns: number;
    cellWidth: number;
  }
  export interface ExportedFrame { canvas: HTMLCanvasElement; layout: Layout }
  export async function canDecode(source: FrameSource): Promise<boolean>;
  export async function* renderRange(
    source: FrameSource,
    timestamps: number[],
    settings: RenderSettings,
    signal: AbortSignal,
  ): AsyncGenerator<ExportedFrame>;

  // mp4.ts
  export interface Mp4Options { fps: number; width: number; height: number }
  export async function canEncodeMp4(): Promise<boolean>;
  export async function encodeMp4(
    frames: AsyncIterable<ExportedFrame>,
    options: Mp4Options,
  ): Promise<Blob>;
  ```

- [ ] **Step 1: Install the dependency**

Run: `bun add mediabunny`

Then read the installed API surface before writing against it. The spec flags a real disagreement between mediabunny's README and its guide over the quality option's name:

Run: `ls node_modules/mediabunny/dist/` and open the bundled `.d.ts` to confirm the exact spelling of `CanvasSource`'s options and of `Output.addVideoTrack`. Use what the types say, not what this plan or the docs say.

- [ ] **Step 2: Write the failing e2e test**

Frame extraction needs WebCodecs, which does not exist in Node, so this cannot be a vitest test. The browser is the only place it runs.

Append to `web/e2e/player.spec.ts`:

```ts
test("exports the marked range as a real MP4", async ({ page }) => {
  await page.goto("/");
  await expect
    .poll(async () => await page.locator(".clock").innerText(), { timeout: 15_000 })
    .not.toBe("0:00 / 0:00");

  await page.getByRole("button", { name: "pause" }).click();
  await page.locator(".seek").fill("2");
  await page.getByRole("button", { name: "set in", exact: true }).click();
  await page.locator(".seek").fill("3");
  await page.getByRole("button", { name: "set out", exact: true }).click();

  const download = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    page.getByRole("button", { name: "export mp4", exact: true }).click(),
  ]).then(([event]) => event);

  const path = await download.path();
  const bytes = await import("node:fs/promises").then((fs) => fs.readFile(path!));
  expect(bytes.byteLength).toBeGreaterThan(2000);
  // An MP4 carries "ftyp" at offset 4. Asserting a file merely appeared would pass on an
  // empty blob, which is exactly the failure worth catching.
  expect(bytes.subarray(4, 8).toString("latin1")).toBe("ftyp");
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun run e2e 2>&1 | tail -20`
Expected: FAIL, waiting for `getByRole('button', { name: 'export mp4' })`.

- [ ] **Step 4: Write the frame generator**

Create `web/lib/export/frames.ts`:

```ts
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

    for await (const sample of sink.samplesAtTimestamps(timestamps)) {
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
```

Note on `sample.toCanvasImageSource()`: confirm the accessor name against the installed `.d.ts` in Step 1. If mediabunny exposes only `sample.draw(context, ...)`, draw the sample into a scratch canvas first and pass that canvas as `source` instead.

- [ ] **Step 5: Write the MP4 encoder**

Create `web/lib/export/mp4.ts`:

```ts
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
  const { BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality } = await import(
    "mediabunny"
  );

  const canvas = document.createElement("canvas");
  canvas.width = options.width;
  canvas.height = options.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("could not get a canvas context for encoding");

  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const videoSource = new CanvasSource(canvas, {
    codec: "avc",
    bitrate: new Quality({ bitrate: MP4_BITRATE }),
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
```

The `bitrate` versus `quality` option name and the `videoSource.add` signature both come from Step 1's reading of the types. Correct them there rather than guessing.

- [ ] **Step 6: Wire the button**

In `AsciiPlayer.tsx`: change `source` state to carry the file, since `openFile` currently discards it.

```ts
const [source, setSource] = useState<{ src: string; label: string; file?: File }>(CLIPS[0]);
```

```ts
const openFile = useCallback((file: File) => {
  setSource({ src: URL.createObjectURL(file), label: file.name, file });
  setNotice(null);
}, []);
```

Then the export handler:

```ts
const exportVideo = useCallback(async () => {
  const layout = layoutRef.current;
  if (!layout) return;
  const fps = fpsFor("mp4");
  const timestamps = frameTimestamps({ ...effectiveRange, fps, speed });
  const cellWidth = cellWidthFor(shellRef.current!.clientWidth, columns);
  const frames = renderRange(
    { url: source.src, file: source.file },
    timestamps,
    { mode, monoInk, charsetRamp: CHARSET_PRESETS[charset], columns, cellWidth },
    new AbortController().signal,
  );
  const blob = await encodeMp4(frames, {
    fps,
    width: layout.cellColumns * cellWidth,
    height: layout.cellRows * cellWidth * 2,
  });
  download(blob, "asciiplay.mp4");
}, [charset, columns, download, effectiveRange, mode, monoInk, source, speed]);
```

```tsx
<button type="button" onClick={() => void exportVideo()}>
  export mp4
</button>
```

- [ ] **Step 7: Run all gates and the e2e**

Run: `bun run typecheck && bun run lint && bun run test && bun run format:check`
Run: `bun run e2e 2>&1 | tail -20`
Expected: 9 passed.

- [ ] **Step 8: Commit**

```bash
git add web/lib/export web/components/AsciiPlayer.tsx web/e2e/player.spec.ts web/package.json web/bun.lock
git commit -m "Web: offline MP4 export of the marked range

Decodes exactly the frames the timeline asks for with mediabunny, renders
each through the extracted renderer and encodes at a fixed 30fps, so the
output no longer depends on what the browser managed in realtime.

Silent for now, and no progress or cancel yet. The e2e test asserts an
ftyp box rather than merely that a download happened, because an empty
blob passes the weaker check."
```

---

### Task 5: GIF export, the format choice, and a calibrated size estimate

**Files:**
- Create: `web/lib/export/gif.ts`
- Modify: `web/components/AsciiPlayer.tsx`
- Modify: `web/lib/export/timeline.ts` (the `GIF_BYTES_PER_CELL` constant only, after measuring)
- Modify: `web/e2e/player.spec.ts`
- Modify: `development-log.md` (record the measurement)

**Interfaces:**
- Consumes: `frames.ts` (`ExportedFrame`), `timeline.ts`
- Produces: `export async function encodeGif(frames: AsyncIterable<ExportedFrame>, options: { fps: number; width: number; height: number }): Promise<Blob>`

- [ ] **Step 1: Install gifenc**

Run: `bun add gifenc`

- [ ] **Step 2: Write the failing e2e test**

```ts
test("exports the marked range as a real GIF", async ({ page }) => {
  await page.goto("/");
  await expect
    .poll(async () => await page.locator(".clock").innerText(), { timeout: 15_000 })
    .not.toBe("0:00 / 0:00");

  await page.getByRole("button", { name: "pause" }).click();
  await page.locator(".seek").fill("2");
  await page.getByRole("button", { name: "set in", exact: true }).click();
  await page.locator(".seek").fill("3");
  await page.getByRole("button", { name: "set out", exact: true }).click();
  await page.getByRole("button", { name: "gif", exact: true }).click();

  const download = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    page.getByRole("button", { name: /^export/ }).click(),
  ]).then(([event]) => event);

  const path = await download.path();
  const bytes = await import("node:fs/promises").then((fs) => fs.readFile(path!));
  expect(bytes.subarray(0, 6).toString("latin1")).toBe("GIF89a");
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun run e2e 2>&1 | tail -20`
Expected: FAIL, waiting for the `gif` button.

- [ ] **Step 4: Write the GIF encoder**

Create `web/lib/export/gif.ts`:

```ts
import type { ExportedFrame } from "./frames";

export interface GifOptions {
  fps: number;
  width: number;
  height: number;
}

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
  // GIF frame delays are centiseconds, so a frame rate that does not divide 100 is rounded.
  const delay = Math.round(100 / options.fps) * 10;

  for await (const frame of frames) {
    context.drawImage(frame.canvas, 0, 0, options.width, options.height);
    const { data } = context.getImageData(0, 0, options.width, options.height);
    const palette = quantize(data, 256);
    encoder.writeFrame(applyPalette(data, palette), options.width, options.height, {
      palette,
      delay,
    });
  }

  encoder.finish();
  return new Blob([encoder.bytesView()], { type: "image/gif" });
}
```

- [ ] **Step 5: Add the format choice and the estimate readout**

In `AsciiPlayer.tsx`, add `const [format, setFormat] = useState<ExportFormat>("mp4");`, a two-button fieldset for `mp4` and `gif`, and generalise `exportVideo` to branch on `format` between `encodeMp4` and `encodeGif`, with `fpsFor(format)` and the matching filename extension.

Show the estimate, and refuse over the ceiling:

```tsx
<span className="estimate">~{Math.round(estimate / (1024 * 1024))}MB</span>
```

```ts
if (exceedsCeiling(format, estimate)) {
  setNotice("that range would make a GIF too big to build here. Shorten it or narrow the width");
  return;
}
```

- [ ] **Step 6: Calibrate the GIF estimate against reality**

Export a five second GIF from the bundled clip at the default 110 columns. Compare the actual byte count with `estimatedBytes("gif", ...)`. Adjust `GIF_BYTES_PER_CELL` in `timeline.ts` so the estimate lands within roughly 30% of the real size, then re-run `bun run test` since the ceiling tests depend on the constant. Widen the test's numbers if the new constant makes the "over the ceiling" case no longer exceed it.

Record the measured number in `development-log.md` under a `## 2026-09-09` heading: the range exported, the cell grid, the estimate before and after, and the actual size. The constant is only defensible with the measurement written next to it.

- [ ] **Step 7: Run all gates and the e2e**

Run: `bun run typecheck && bun run lint && bun run test && bun run format:check`
Run: `bun run e2e 2>&1 | tail -20`
Expected: 10 passed.

- [ ] **Step 8: Commit**

```bash
git add web/lib/export web/components/AsciiPlayer.tsx web/e2e/player.spec.ts web/package.json web/bun.lock development-log.md
git commit -m "Web: GIF export, with a size estimate that was measured

Same frames as the MP4 path, quantised to 256 colours by gifenc at 12fps.
The estimate's bytes-per-cell constant is calibrated against a real
export rather than guessed, and the measurement is in the development log
so the next person can tell the difference between a derived number and a
number someone liked."
```

---

### Task 6: Audio in the MP4

**Files:**
- Create: `web/lib/export/audio.ts`
- Modify: `web/lib/export/mp4.ts`
- Modify: `web/components/AsciiPlayer.tsx`

**Interfaces:**
- Consumes: `frames.ts` (`FrameSource`), `timeline.ts` (`Range`)
- Produces:
  ```ts
  export type AudioAvailability =
    | { kind: "available" }
    | { kind: "unavailable"; reason: string };
  export async function audioAvailability(
    source: FrameSource,
    speed: number,
  ): Promise<AudioAvailability>;
  ```
  and `Mp4Options` gains `audio: { source: FrameSource; range: Range } | null`.

- [ ] **Step 1: Install the AAC encoder extension**

Run: `bun add @mediabunny/aac-encoder`

It is only registered when the browser has no native AAC encoder, so it is a fallback rather than the default path.

- [ ] **Step 2: Write the availability rules, test first**

Create `web/lib/export/audio.test.ts`. The decode side needs a browser, but the speed rule is pure and is the part that will actually get edited later:

```ts
import { describe, expect, it } from "vitest";
import { silentBecauseOfSpeed } from "./audio";

describe("silentBecauseOfSpeed", () => {
  it("keeps audio at normal speed", () => {
    expect(silentBecauseOfSpeed(1)).toBe(false);
  });

  it("drops audio at any other speed", () => {
    // Resampling without a pitch shift is a separate problem, so the honest answer is silence
    // plus a notice rather than audio at the wrong pitch.
    expect(silentBecauseOfSpeed(0.5)).toBe(true);
    expect(silentBecauseOfSpeed(2)).toBe(true);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun run test`
Expected: FAIL with `Cannot find module './audio'`.

- [ ] **Step 4: Write the module**

Create `web/lib/export/audio.ts`:

```ts
import type { FrameSource } from "./frames";

export type AudioAvailability = { kind: "available" } | { kind: "unavailable"; reason: string };

export function silentBecauseOfSpeed(speed: number): boolean {
  return speed !== 1;
}

/** Registers the fallback encoder only when the browser lacks a native one. */
export async function ensureAacEncoder(): Promise<boolean> {
  const { canEncodeAudio } = await import("mediabunny");
  if (await canEncodeAudio("aac")) return true;
  try {
    const { registerAacEncoder } = await import("@mediabunny/aac-encoder");
    registerAacEncoder();
    return await canEncodeAudio("aac");
  } catch {
    return false;
  }
}

export async function audioAvailability(
  source: FrameSource,
  speed: number,
): Promise<AudioAvailability> {
  if (silentBecauseOfSpeed(speed)) {
    return { kind: "unavailable", reason: "audio is dropped when the speed is not 1x" };
  }
  const { ALL_FORMATS, BlobSource, Input, UrlSource } = await import("mediabunny");
  const input = new Input({
    formats: ALL_FORMATS,
    source: source.file ? new BlobSource(source.file) : new UrlSource(source.url),
  });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return { kind: "unavailable", reason: "that file has no audio track" };
    if (!(await track.canDecode())) {
      return { kind: "unavailable", reason: "this browser cannot decode that audio" };
    }
  } finally {
    input.dispose();
  }
  if (!(await ensureAacEncoder())) {
    return { kind: "unavailable", reason: "this browser cannot encode AAC, so the MP4 is silent" };
  }
  return { kind: "available" };
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `bun run test`
Expected: PASS.

- [ ] **Step 6: Add the audio track to the MP4 output**

In `mp4.ts`, when `options.audio` is set, read the input's audio and add it to the output. The exact reading API is the second detail the spec flagged as unresolved: check the installed types for an audio sink that yields `AudioBuffer` or `AudioSample`, pair it with the matching `AudioBufferSource` or `AudioSampleSource`, and trim to `options.audio.range`. If no sink fits, run mediabunny's `Conversion` for the audio track alone with `trim` set, and mux the result.

Whichever route the types support, the failure mode is the same: catch, skip the audio track, and surface the reason through the notice. A silent MP4 beats no MP4.

- [ ] **Step 7: Surface the reason in the UI**

Before starting an export, call `audioAvailability` and, when it comes back unavailable and the format is MP4, set the notice to its `reason` while still exporting. The user should learn why their clip is silent without the export failing.

- [ ] **Step 8: Verify by hand, because a silent track and a missing track look the same**

Export a two second MP4 from the bundled clip with the sound unmuted, then confirm the file really carries audio:

Run: `ffprobe -hide_banner -loglevel error -show_entries stream=codec_type,codec_name -of csv=p=0 ~/Downloads/asciiplay.mp4`
Expected: two lines, one `video`, one `audio`.

Then repeat with speed set to 2x and confirm only the video line appears.

- [ ] **Step 9: Run all gates and commit**

```bash
git add web/lib/export web/components/AsciiPlayer.tsx web/package.json web/bun.lock
git commit -m "Web: carry the source audio into the exported MP4

Native AAC where the browser has it, mediabunny's AAC extension where it
does not, and silence as a last resort with the reason shown rather than
swallowed. Silent by design at any speed other than 1x, because
resampling without a pitch shift is a different problem.

Verified with ffprobe rather than by listening, since a silent track and
a missing track sound identical."
```

---

### Task 7: Progress, cancel, and removing the realtime capture

**Files:**
- Modify: `web/components/AsciiPlayer.tsx`
- Modify: `web/e2e/player.spec.ts`

**Interfaces:**
- Consumes: everything above
- Produces: a `.export-progress` element reading `12 / 30 frames`, and no `MediaRecorder` anywhere in the codebase

- [ ] **Step 1: Write the failing e2e test**

```ts
test("a cancelled export downloads nothing and leaves the panel idle", async ({ page }) => {
  await page.goto("/");
  await expect
    .poll(async () => await page.locator(".clock").innerText(), { timeout: 15_000 })
    .not.toBe("0:00 / 0:00");

  let downloaded = false;
  page.on("download", () => {
    downloaded = true;
  });

  await page.getByRole("button", { name: "export mp4", exact: true }).click();
  await expect(page.locator(".export-progress")).toBeVisible();
  await page.getByRole("button", { name: "cancel", exact: true }).click();

  await expect(page.locator(".export-progress")).toBeHidden();
  await expect(page.getByRole("button", { name: "export mp4", exact: true })).toBeEnabled();
  await page.waitForTimeout(1500);
  expect(downloaded, "a cancelled export still produced a file").toBe(false);
});
```

The clip is long enough that a whole-range export cannot finish inside the click, which is what makes this test meaningful. Use the full range, not a one second one.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run e2e 2>&1 | tail -20`
Expected: FAIL, `.export-progress` never visible.

- [ ] **Step 3: Add progress and cancel**

Hold an `AbortController` in a ref, count frames as the generator yields, and render `{done} / {total} frames` plus a cancel button while an export runs. Disable the export button for the duration. On abort, discard the blob and clear the state without downloading.

Abort on unmount too, in the effect cleanup, or a decoder outlives the component:

```ts
useEffect(() => () => exportAbortRef.current?.abort(), []);
```

- [ ] **Step 4: Delete the realtime capture**

Remove `recorderRef`, `webmChunksRef`, `webmUrl`, the `MediaRecorder` block inside `startRecording`, and the WebM download button. Keep `startRecording` and `stopRecording` themselves: they still drive `.cast` accumulation, which is a separate feature and must keep working.

Verify nothing is left behind:

Run: `grep -rn "MediaRecorder\|webm" web/components web/lib web/app`
Expected: no matches.

- [ ] **Step 5: Confirm .cast still works**

Run: `bun run e2e 2>&1 | tail -20`
Expected: 11 passed, including the existing blocks-mode copy test. If `.cast` broke, the `startRecording` edit went too far.

- [ ] **Step 6: Run all gates and commit**

```bash
git add web/components/AsciiPlayer.tsx web/e2e/player.spec.ts
git commit -m "Web: export progress and cancel, and the WebM path removed

An export is a few hundred decode, render and encode cycles, so it needs
a frame counter and a way out. Cancelling aborts the generator, disposes
the input and downloads nothing.

The realtime MediaRecorder capture is gone now that something better
replaces it. Recording still exists for .cast, which was always a
separate feature sharing the same button."
```

---

### Task 8: Update the README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Correct the export list**

`README.md` line 45 currently claims the web app "exports to WebM, PNG". It now exports MP4, GIF, PNG and `.cast`, and it has in and out markers. Rewrite that sentence to match, and mention that a browser without an H.264 encoder is offered GIF only.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "README: the web app's exports, as they now are"
```

---

## Self-Review

**Spec coverage.** Deterministic offline render: Tasks 1, 4. In and out points: Task 3. MP4 and GIF, WebM removed: Tasks 4, 5, 7. Audio with fallbacks: Task 6. Format and range as the only controls: Tasks 3, 5. Fixed fps per format: Task 2. 1x rendering: Task 4, Step 4. Size estimate and ceiling: Tasks 2, 5. Error handling for undecodable sources and missing encoders: `canDecode` and `canEncodeMp4` in Task 4, `audioAvailability` in Task 6. Cancel and unmount disposal: Task 7. Dynamic imports: every encoder module. Testing split between pure vitest and browser Playwright: throughout.

**One spec item deliberately deferred, not dropped.** The spec's error-handling section asks for the MP4 option to be disabled with a notice when `canEncodeVideo('avc')` is false. `canEncodeMp4()` exists from Task 4 but nothing calls it until Task 5 introduces the format choice. Wire it there, in Task 5 Step 5, alongside the format buttons.

**Image input is not in this plan.** It is the second plan, `2026-09-09-web-image-input.md`, and depends only on Task 1 of this one.

**Two API details are load-bearing and unresolved by design**, both flagged in the spec and both to be settled by reading the installed `.d.ts` rather than trusting this plan: `CanvasSource`'s quality option name and `videoSource.add`'s signature in Task 4, and the audio reading API in Task 6. A plan that guessed them would read as more finished and be worth less.
