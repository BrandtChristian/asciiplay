import { expect, test } from "@playwright/test";

/**
 * The flow that actually matters: the page arrives already playing, and the canvas is really
 * being painted from video rather than sitting empty. Everything else on the page is a control
 * over that one loop.
 */

async function canvasStats(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas") as HTMLCanvasElement | null;
    if (!canvas) return null;
    const context = canvas.getContext("2d");
    if (!context) return null;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let lit = 0;
    let colourful = 0;
    for (let index = 0; index < data.length; index += 4) {
      const [red, green, blue] = [data[index], data[index + 1], data[index + 2]];
      if (red + green + blue > 30) lit += 1;
      if (Math.max(red, green, blue) - Math.min(red, green, blue) > 25) colourful += 1;
    }
    const total = data.length / 4;
    return {
      width: canvas.width,
      litFraction: lit / total,
      colourfulFraction: colourful / total,
    };
  });
}

// A hash of the whole frame, used to tell whether the canvas changed between two moments.
// Must cover the whole canvas, not a slice of canvas.toDataURL(): the tail of that data URL is
// only the bottom rows of the PNG, and a frame whose lower region happens to be static hashes
// the same as the previous one, making two genuinely different frames compare equal.
async function fingerprint(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    const context = canvas.getContext("2d")!;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let hash = 0;
    for (let index = 0; index < data.length; index += 4) {
      hash = (hash * 31 + data[index] + data[index + 1] * 7 + data[index + 2] * 13) | 0;
    }
    return hash;
  });
}

// Locator.fill() dispatches "input" then "change" synchronously on a range input. The
// "input" seeks to the target value, but React's controlled-input re-render reverts the
// input's DOM value before "change" fires, so "change" replays the onChange handler against
// that reverted, stale value and the seek lands the video back near zero. A single native
// "input" event, which is what a real drag fires, only triggers the first half of that and
// avoids the replay. A paused seek does fire timeupdate and does reach React state, so this is
// a quirk of fill() on a controlled range input, not an app bug: seekTo deliberately does not
// also call setPosition. Requires the video to already be paused.
function seekWhilePaused(page: import("@playwright/test").Page, seconds: number) {
  return page.locator(".seek").evaluate((input: HTMLInputElement, value: number) => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, seconds);
}

test("arrives playing, with a canvas painted from the video", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("canvas")).toBeVisible();

  // The loop only paints once the video has a frame, so give it a moment rather than racing it.
  await expect
    .poll(async () => (await canvasStats(page))?.litFraction ?? 0, { timeout: 15_000 })
    .toBeGreaterThan(0.01);

  const stats = await canvasStats(page);
  expect(stats!.width).toBeGreaterThan(200);
  // Colour mode must actually be in colour, not accidentally painting monochrome.
  expect(stats!.colourfulFraction).toBeGreaterThan(0.005);

  await expect(page.locator(".readout")).toContainText("cells");
});

test("the picture changes over time, so it is playing and not one stuck frame", async ({
  page,
}) => {
  await page.goto("/");
  await expect
    .poll(async () => (await canvasStats(page))?.litFraction ?? 0, { timeout: 15_000 })
    .toBeGreaterThan(0.01);

  const before = await fingerprint(page);
  await expect.poll(() => fingerprint(page), { timeout: 10_000 }).not.toBe(before);
});

test("every mode and charset paints something, and no pressed label goes invisible", async ({
  page,
}) => {
  await page.goto("/");
  await expect
    .poll(async () => (await canvasStats(page))?.litFraction ?? 0, { timeout: 15_000 })
    .toBeGreaterThan(0.01);

  for (const label of ["amber", "b&w", "reverse", "blocks", "colour", "shades", "long", "ascii"]) {
    const button = page.getByRole("button", { name: label, exact: true });
    if (await button.isDisabled()) continue;
    await button.click();
    await page.waitForTimeout(350);

    const stats = await canvasStats(page);
    expect(stats!.litFraction, `${label} painted nothing`).toBeGreaterThan(0.005);

    // A pressed button whose text matches its background is unreadable. This caught a real
    // cascade collision: the hover rule outranked the pressed rule.
    const invisible = await page.evaluate(() =>
      [...document.querySelectorAll('button[aria-pressed="true"]')]
        .map((element) => {
          const style = getComputedStyle(element);
          return {
            text: element.textContent,
            color: style.color,
            background: style.backgroundColor,
          };
        })
        .filter((row) => row.color === row.background),
    );
    expect(invisible, `after ${label}`).toEqual([]);
  }
});

test("copy is refused with an explanation in blocks mode", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "blocks", exact: true }).click();
  await page.getByRole("button", { name: "copy", exact: true }).click();
  // Blocks mode paints pixels, so there are no glyph rows to copy, and saying so beats
  // silently copying an empty string.
  await expect(page.locator(".readout")).toContainText("blocks mode paints pixels");
});

test("pause actually stops the picture, and play resumes it", async ({ page }) => {
  await page.goto("/");
  await expect
    .poll(async () => (await canvasStats(page))?.litFraction ?? 0, { timeout: 15_000 })
    .toBeGreaterThan(0.01);

  await page.getByRole("button", { name: "pause" }).click();
  await page.waitForTimeout(400);
  const paused = await fingerprint(page);
  // Fixed wait is correct here: proving the canvas does NOT change means waiting a set period
  // and then checking, not polling until something happens.
  await page.waitForTimeout(900);
  expect(await fingerprint(page), "the canvas kept changing while paused").toBe(paused);

  await page.getByRole("button", { name: "play" }).click();
  await expect
    .poll(() => fingerprint(page), { timeout: 10_000, message: "play did not resume" })
    .not.toBe(paused);
});

test("the seek bar moves the video", async ({ page }) => {
  await page.goto("/");
  await expect
    .poll(async () => await page.locator(".clock").innerText(), { timeout: 15_000 })
    .not.toBe("0:00 / 0:00");

  await page.locator(".seek").fill("6");
  await expect(page.locator(".clock")).toContainText("0:06");
});

test("in and out markers define a range on the transport", async ({ page }) => {
  await page.goto("/");
  await expect
    .poll(async () => await page.locator(".clock").innerText(), { timeout: 15_000 })
    .not.toBe("0:00 / 0:00");

  // Pause first: otherwise playback keeps advancing position between the seek and the click,
  // and the marker button reads the wrong instant.
  await page.getByRole("button", { name: "pause" }).click();

  await seekWhilePaused(page, 2);
  await expect(page.locator(".clock")).toContainText("0:02");
  await page.getByRole("button", { name: "set in", exact: true }).click();

  await seekWhilePaused(page, 7);
  await expect(page.locator(".clock")).toContainText("0:07");
  await page.getByRole("button", { name: "set out", exact: true }).click();

  await expect(page.locator(".range-readout")).toContainText("in 0:02");
  await expect(page.locator(".range-readout")).toContainText("out 0:07");
});

test("the mono treatments invert the paper, not just the ink", async ({ page }) => {
  await page.goto("/");
  await expect
    .poll(async () => (await canvasStats(page))?.litFraction ?? 0, { timeout: 15_000 })
    .toBeGreaterThan(0.01);

  await page.getByRole("button", { name: "amber", exact: true }).click();
  await page.waitForTimeout(350);
  const onBlack = await canvasStats(page);
  // Light glyphs on a dark ground: most of the canvas is unlit, only the glyphs are.
  expect(onBlack!.litFraction, "amber should sit on a dark ground").toBeLessThan(0.5);

  await page.getByRole("button", { name: "reverse", exact: true }).click();
  await page.waitForTimeout(350);
  const onWhite = await canvasStats(page);
  // Reverse is paper: nearly every pixel is lit, and the glyphs are the dark part. Getting this
  // wrong by only swapping the glyph colour leaves a dark canvas and looks like a negative.
  expect(onWhite!.litFraction, "reverse should sit on a light ground").toBeGreaterThan(0.8);
});

test("reverse mode drops the CRT scanlines, which only work on a dark screen", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".scanlines")).toBeVisible();

  await page.getByRole("button", { name: "reverse", exact: true }).click();
  // The overlay multiplies, so over black it vanishes and over white paper it is grey banding.
  await expect(page.locator(".scanlines")).toHaveCount(0);

  await page.getByRole("button", { name: "amber", exact: true }).click();
  await expect(page.locator(".scanlines")).toBeVisible();
});

test("exports the marked range as a real MP4", async ({ page }) => {
  await page.goto("/");
  await expect
    .poll(async () => await page.locator(".clock").innerText(), { timeout: 15_000 })
    .not.toBe("0:00 / 0:00");

  await page.getByRole("button", { name: "pause" }).click();
  // 8 to 9, not 2 to 3: big-buck-bunny.mp4's video track only starts at 6.625s (its first ~6.6s
  // is an audio-only lead-in), so a range inside that lead-in would export correctly as "no
  // video in it" and this test would not exercise the real decode path at all.
  await seekWhilePaused(page, 8);
  await page.getByRole("button", { name: "set in", exact: true }).click();
  await seekWhilePaused(page, 9);
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

test("the exported MP4 carries the source's real audio, not a silent track", async ({ page }) => {
  await page.goto("/");
  await expect
    .poll(async () => await page.locator(".clock").innerText(), { timeout: 15_000 })
    .not.toBe("0:00 / 0:00");

  await page.getByRole("button", { name: "pause" }).click();
  // 8 to 9: same lead-in reasoning as the MP4 export test above. big-buck-bunny.mp4's AAC audio
  // runs across the whole clip, so this range also has real sound to check for.
  await seekWhilePaused(page, 8);
  await page.getByRole("button", { name: "set in", exact: true }).click();
  await seekWhilePaused(page, 9);
  await page.getByRole("button", { name: "set out", exact: true }).click();

  const download = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    page.getByRole("button", { name: "export mp4", exact: true }).click(),
  ]).then(([event]) => event);
  const path = await download.path();

  const { spawnSync } = await import("node:child_process");
  const streams = spawnSync("ffprobe", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-show_entries",
    "stream=codec_type,codec_name",
    "-of",
    "csv=p=0",
    path!,
  ])
    .stdout.toString()
    .trim();
  // ffprobe's csv output orders fields by its own struct layout regardless of the
  // -show_entries argument order, hence "h264,video" rather than "video,h264".
  expect(streams).toContain("h264,video");
  expect(streams).toContain("aac,audio");

  // A silent track and a missing one look identical structurally, so decode the audio and read
  // its level: digital silence reports around -91dB, real audio reports far above the floor.
  const SILENCE_FLOOR_DB = -90;
  const volumeReport = spawnSync("ffmpeg", [
    "-hide_banner",
    "-i",
    path!,
    "-map",
    "0:a",
    "-af",
    "volumedetect",
    "-f",
    "null",
    "-",
  ]).stderr.toString();
  const meanVolumeMatch = volumeReport.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
  expect(meanVolumeMatch, `no mean_volume in ffmpeg output:\n${volumeReport}`).not.toBeNull();
  expect(Number(meanVolumeMatch![1])).toBeGreaterThan(SILENCE_FLOOR_DB);
});

test("a speed other than 1x exports video only, and says why", async ({ page }) => {
  await page.goto("/");
  await expect
    .poll(async () => await page.locator(".clock").innerText(), { timeout: 15_000 })
    .not.toBe("0:00 / 0:00");

  await page.getByRole("button", { name: "pause" }).click();
  await seekWhilePaused(page, 8);
  await page.getByRole("button", { name: "set in", exact: true }).click();
  await seekWhilePaused(page, 9);
  await page.getByRole("button", { name: "set out", exact: true }).click();

  // Locator.fill() has the same controlled-input replay problem on this slider as it does on
  // the seek bar (see seekWhilePaused above), so drive it the same way: one native "input" event.
  await page.locator('input[aria-label="speed"]').evaluate((input: HTMLInputElement) => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(input, "2");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  const download = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    page.getByRole("button", { name: "export mp4", exact: true }).click(),
  ]).then(([event]) => event);
  const path = await download.path();

  await expect(page.locator(".readout"), {
    message: "speed-drops-audio notice never appeared",
  }).toContainText("audio is dropped when the speed is not 1x", { timeout: 15_000 });

  const { spawnSync } = await import("node:child_process");
  const streams = spawnSync("ffprobe", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-show_entries",
    "stream=codec_type",
    "-of",
    "csv=p=0",
    path!,
  ])
    .stdout.toString()
    .trim();
  expect(streams.split("\n")).toEqual(["video"]);
});

test("a range with no video in it shows a message and downloads nothing", async ({ page }) => {
  await page.goto("/");
  await expect
    .poll(async () => await page.locator(".clock").innerText(), { timeout: 15_000 })
    .not.toBe("0:00 / 0:00");

  let downloaded = false;
  page.on("download", () => {
    downloaded = true;
  });

  await page.getByRole("button", { name: "pause" }).click();
  // 2 to 3 sits entirely inside the audio-only lead-in (video only starts at 6.625s), so this
  // must fail loudly rather than hand back a playable file with nothing in it.
  await seekWhilePaused(page, 2);
  await page.getByRole("button", { name: "set in", exact: true }).click();
  await seekWhilePaused(page, 3);
  await page.getByRole("button", { name: "set out", exact: true }).click();

  await page.getByRole("button", { name: "export mp4", exact: true }).click();

  // The notice clears itself after 4 seconds, so assert on it while it is still there rather
  // than waiting a fixed period first and reading afterward.
  await expect(page.locator(".readout"), {
    message: "no-video notice never appeared",
  }).toContainText("that range has no video in it", { timeout: 15_000 });
  expect(downloaded, "a range with nothing in it should not produce a file").toBe(false);
});

test("exports the marked range as a real GIF", async ({ page }) => {
  await page.goto("/");
  await expect
    .poll(async () => await page.locator(".clock").innerText(), { timeout: 15_000 })
    .not.toBe("0:00 / 0:00");

  await page.getByRole("button", { name: "pause" }).click();
  // 8 to 9, not 2 to 3: see the MP4 test above, the same lead-in applies here.
  await seekWhilePaused(page, 8);
  await page.getByRole("button", { name: "set in", exact: true }).click();
  await seekWhilePaused(page, 9);
  await page.getByRole("button", { name: "set out", exact: true }).click();
  await page.getByRole("button", { name: "gif", exact: true }).click();

  const download = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    page.getByRole("button", { name: "export gif", exact: true }).click(),
  ]).then(([event]) => event);

  const path = await download.path();
  const bytes = await import("node:fs/promises").then((fs) => fs.readFile(path!));
  expect(bytes.subarray(0, 6).toString("latin1")).toBe("GIF89a");
});

test("a range straddling the video's start still exports, but discloses the shortfall", async ({
  page,
}) => {
  await page.goto("/");
  await expect
    .poll(async () => await page.locator(".clock").innerText(), { timeout: 15_000 })
    .not.toBe("0:00 / 0:00");

  await page.getByRole("button", { name: "pause" }).click();
  // 5 to 8 straddles the boundary: video only exists from 6.625s, so roughly the first third of
  // this range has no sample. The export should still succeed with what does exist, not refuse
  // outright, but say so rather than quietly handing back a shorter clip than was marked.
  await seekWhilePaused(page, 5);
  await page.getByRole("button", { name: "set in", exact: true }).click();
  await seekWhilePaused(page, 8);
  await page.getByRole("button", { name: "set out", exact: true }).click();

  const download = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    page.getByRole("button", { name: "export mp4", exact: true }).click(),
  ]).then(([event]) => event);

  const path = await download.path();
  const bytes = await import("node:fs/promises").then((fs) => fs.readFile(path!));
  expect(bytes.byteLength).toBeGreaterThan(2000);
  expect(bytes.subarray(4, 8).toString("latin1")).toBe("ftyp");

  await expect(page.locator(".readout"), {
    message: "partial-export notice never appeared",
  }).toContainText("the rest of that range has no video", { timeout: 15_000 });
});
