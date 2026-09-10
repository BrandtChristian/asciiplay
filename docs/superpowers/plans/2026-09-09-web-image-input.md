# Still Image Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user open a still image and get it ASCII-ified, with a plain-text download alongside the existing PNG.

**Architecture:** The renderer extracted in the export plan already takes any canvas image source, so an image needs no new rendering path. What it needs is a source type the component can branch on, a render triggered by settings changes rather than by animation frames, and the video-only controls hidden.

**Tech Stack:** Next.js 16.3.4, React 19, TypeScript, Bun, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-09-web-export-and-image-input-design.md`

**Depends on:** `docs/superpowers/plans/2026-09-09-web-offline-export.md` Task 1 only, which extracts `lib/render-frame.ts`. That plan has since landed in full.

**Do this first, and it is not optional.** The export plan's final whole-branch review found that
the spec named a `components/ExportPanel.tsx` which no task ever created, so all of the export UI
accreted into `AsciiPlayer.tsx` instead. That component is now 706 lines, up from 546, and about
200 of those are export concern: the export callback, the frame-counting wrapper, the estimate
formatting, the capability probe, the notice aggregation rule and three JSX blocks.

This plan is where that bill comes due. Task 1 Step 6 asks for the transport, speed, mute, in/out
markers, MP4 and GIF to be ABSENT in image mode. With an ExportPanel that is "do not render it".
Without one it is conditional JSX threaded through the render body of a 706-line component, plus a
guard so the export callback cannot run against an image source. Extract the panel first, as its
own commit with the e2e suite as the net, exactly the way the renderer extraction was done and
verified. Then this plan's Task 1 Step 6 becomes one line.

## Global Constraints

- All work happens in `web/`. Run every command from `web/`.
- TypeScript only. Never introduce a `.js` file.
- Package manager is Bun. No new dependencies are needed for this plan.
- `lib/ascii.ts` must not change. `toPlainText` already exists there and is what the text export uses.
- Never use em dashes or en dashes in code comments, commit messages or docs.
- Gates before every commit, all from `web/`: `bun run typecheck`, `bun run lint`, `bun run test`, `bun run format:check`.

---

### Task 1: Open an image as a source

**Files:**
- Modify: `web/components/AsciiPlayer.tsx`
- Modify: `web/e2e/player.spec.ts`

**Interfaces:**
- Consumes: `lib/render-frame.ts` (`renderFrame`, `createFrameCanvases`, `cellWidthFor`)
- Produces:
  ```ts
  type Source =
    | { kind: "video"; src: string; label: string; file?: File }
    | { kind: "image"; src: string; label: string; file: File };
  ```
  and a `.source-kind` element whose text is `video` or `image`, which the e2e test reads.

- [ ] **Step 1: Write the failing e2e test**

`app/opengraph-image.png` is already in the repo, so it serves as the fixture and no new binary file is needed.

Append to `web/e2e/player.spec.ts`:

```ts
test("an image opens as a still, with the transport gone", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("canvas")).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles("app/opengraph-image.png");

  await expect(page.locator(".source-kind")).toHaveText("image");
  // A still has nothing to play, seek or mute, so those controls are absent rather than
  // present and inert.
  await expect(page.getByRole("button", { name: "pause" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "play" })).toHaveCount(0);
  await expect(page.locator(".seek")).toHaveCount(0);

  // It still has to actually paint, which is the whole point.
  await expect
    .poll(async () => (await canvasStats(page))?.litFraction ?? 0, { timeout: 10_000 })
    .toBeGreaterThan(0.01);
});

test("switching modes still repaints a still image", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles("app/opengraph-image.png");
  await expect
    .poll(async () => (await canvasStats(page))?.litFraction ?? 0, { timeout: 10_000 })
    .toBeGreaterThan(0.01);

  const fingerprint = async () =>
    page.evaluate(() =>
      (document.querySelector("canvas") as HTMLCanvasElement).toDataURL().slice(-2000),
    );

  const before = await fingerprint();
  await page.getByRole("button", { name: "reverse", exact: true }).click();
  await page.waitForTimeout(400);
  // There is no animation loop to pick the change up, so a settings change has to drive the
  // repaint itself. This is the test that catches a still frame going stale.
  expect(await fingerprint(), "the still did not repaint after a mode change").not.toBe(before);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run e2e 2>&1 | tail -20`
Expected: FAIL. The file input rejects a PNG today, because it is `accept="video/*"` and `onDrop` sets the notice "that was not a video file".

- [ ] **Step 3: Widen the file affordance**

In `AsciiPlayer.tsx`, change the input at roughly line 522:

```tsx
<input type="file" accept="video/*,image/*" onChange={...} />
```

and the drop handler, which currently rejects anything that is not a video:

```ts
const file = event.dataTransfer.files[0];
if (file?.type.startsWith("video/") || file?.type.startsWith("image/")) openFile(file);
else setNotice("that was not a video or an image");
```

- [ ] **Step 4: Give the source a kind**

```ts
type Source =
  | { kind: "video"; src: string; label: string; file?: File }
  | { kind: "image"; src: string; label: string; file: File };

const [source, setSource] = useState<Source>({ kind: "video", ...CLIPS[0] });

const openFile = useCallback((file: File) => {
  setSource({
    kind: file.type.startsWith("image/") ? "image" : "video",
    src: URL.createObjectURL(file),
    label: file.name,
    file,
  });
  setNotice(null);
}, []);
```

Render the kind so the test and the user can both see it:

```tsx
<span className="source-kind">{source.kind}</span>
```

- [ ] **Step 5: Render a still when settings change**

An image has no animation frames, so the rAF loop has nothing to do. Bail out of it early:

```ts
// Inside tick, next to the existing readyState guard.
if (source.kind === "image") return;
```

`tick` reads settings through `settingsRef` so it never restarts; it needs `source.kind` the same way, so add `kind` to that ref alongside the rest.

Then render the still from an effect, which is what makes a control change repaint:

```ts
useEffect(() => {
  if (source.kind !== "image") return;
  const display = displayRef.current;
  const shell = shellRef.current;
  if (!display || !shell) return;

  const image = new Image();
  image.src = source.src;
  let cancelled = false;
  void image
    .decode()
    .then(() => {
      if (cancelled) return;
      const frame = renderFrame(canvasesRef.current!, {
        source: image,
        sourceWidth: image.naturalWidth,
        sourceHeight: image.naturalHeight,
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
      setGrid({ columns: frame.layout.cellColumns, rows: frame.layout.cellRows });
    })
    .catch(() => setNotice("that image could not be decoded"));
  return () => {
    cancelled = true;
  };
}, [source, mode, monoInk, charset, columns]);
```

- [ ] **Step 6: Hide the video-only controls**

Wrap the transport row, the seek bar, the clock, the speed control, the mute button and the in/out range row in `{source.kind === "video" && (...)}`. Leave the mode, charset and width controls alone: they all apply to a still.

If the export plan has already landed, hide the MP4 and GIF export controls too. A still has no range to export as video, and the spec says these are absent rather than disabled.

- [ ] **Step 7: Reset to a clip cleanly**

Selecting one of the bundled clips must set `kind: "video"` again, or the still-render effect keeps painting over the video. Check every `setSource` call site.

- [ ] **Step 8: Run all gates and the e2e**

Run: `bun run typecheck && bun run lint && bun run test && bun run format:check`
Run: `bun run e2e 2>&1 | tail -20`
Expected: all previous tests plus the two new ones pass.

- [ ] **Step 9: Commit**

```bash
git add web/components/AsciiPlayer.tsx web/e2e/player.spec.ts
git commit -m "Web: open a still image as a source

The extracted renderer already took any image source, so this is a source
kind, a render driven by settings changes instead of by animation frames,
and the video-only controls hidden rather than left inert.

The second test is the one that matters: with no rAF loop running, a
control change has to drive its own repaint, and a stale still frame is
the failure that would otherwise ship looking fine."
```

---

### Task 2: Download the ASCII as a text file

**Files:**
- Modify: `web/components/AsciiPlayer.tsx`
- Modify: `web/e2e/player.spec.ts`

**Interfaces:**
- Consumes: `lib/ascii.ts` (`toPlainText`), the existing `download` helper and `rowsRef`
- Produces: a `.txt` button

- [ ] **Step 1: Write the failing e2e test**

```ts
test("downloads the frame as a text file", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles("app/opengraph-image.png");
  await expect
    .poll(async () => (await canvasStats(page))?.litFraction ?? 0, { timeout: 10_000 })
    .toBeGreaterThan(0.01);

  const download = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: ".txt", exact: true }).click(),
  ]).then(([event]) => event);

  const path = await download.path();
  const text = await import("node:fs/promises").then((fs) => fs.readFile(path!, "utf8"));
  const lines = text.split("\n").filter((line) => line.length > 0);
  expect(lines.length).toBeGreaterThan(5);
  // Every row of a monospace grid is the same width, or it is not a grid.
  expect(new Set(lines.map((line) => line.length)).size).toBe(1);
});

test("the text download is refused in blocks mode, with a reason", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "blocks", exact: true }).click();
  await page.getByRole("button", { name: ".txt", exact: true }).click();
  await expect(page.locator(".readout")).toContainText("blocks mode paints pixels");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run e2e 2>&1 | tail -20`
Expected: FAIL, waiting for the `.txt` button.

- [ ] **Step 3: Add the handler and the button**

`rowsRef` is empty in blocks mode, because blocks paints pixels rather than glyphs, so the same guard the clipboard copy already uses applies here:

```ts
const downloadText = useCallback(() => {
  if (rowsRef.current.length === 0) {
    setNotice("blocks mode paints pixels, not text. Switch to ascii or mono to save text");
    return;
  }
  const name = source.label.replace(/\.[^.]+$/, "");
  download(new Blob([toPlainText(rowsRef.current)], { type: "text/plain" }), `${name}.txt`);
}, [download, source.label]);
```

```tsx
<button type="button" onClick={downloadText}>
  .txt
</button>
```

Place it beside the existing `png` and `copy` buttons. It applies to a paused video frame just as well as to a still, so it is not conditional on the source kind.

- [ ] **Step 4: Run all gates and the e2e**

Run: `bun run typecheck && bun run lint && bun run test && bun run format:check`
Run: `bun run e2e 2>&1 | tail -20`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add web/components/AsciiPlayer.tsx web/e2e/player.spec.ts
git commit -m "Web: save the frame as a text file

The glyph rows already existed for the clipboard copy, so this is the
same data written to disk, which is the form you want for a README or a
terminal banner. Refused in blocks mode for the same reason copy is:
there are no glyphs to save."
```

---

### Task 3: Update the README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Say that images work**

The README describes the web app as a video player. Add that it also opens a still image and exports the result as PNG or text. Keep it to a sentence or two in the existing web section around line 45.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "README: the web app takes images too"
```

---

## Self-Review

**Spec coverage.** Image accepted as a source: Task 1, Steps 3 and 4. Transport, speed, mute and in/out absent in image mode: Task 1, Step 6. Render driven by settings rather than rAF: Task 1, Step 5, with a test that specifically catches a stale frame. PNG unchanged and `.txt` added for ascii and mono: Task 2. Blocks mode has no text and says so: Task 2, Step 3.

**Two ordering notes worth stating plainly.** Task 1 Step 6 mentions hiding the export controls, which only exist if the export plan has landed. If this plan runs first, skip that sentence.

Both plans also edit the same `source` state. The export plan's Task 4 widens it to carry the original `File`, and this plan's Task 1 widens it again with `kind`. Whichever lands second finds part of its change already made, which is harmless: keep the union with both `kind` and `file`, and do not remove either. The end state is the `Source` type declared in Task 1 above.

**No new dependencies.** `toPlainText` and the `download` helper both already exist, and `app/opengraph-image.png` serves as the test fixture, so nothing new enters the bundle or the repo.
