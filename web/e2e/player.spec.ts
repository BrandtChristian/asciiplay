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

  const fingerprint = async () =>
    page.evaluate(() => {
      const canvas = document.querySelector("canvas") as HTMLCanvasElement;
      return canvas.toDataURL().slice(-2000);
    });

  const before = await fingerprint();
  await page.waitForTimeout(1200);
  expect(await fingerprint()).not.toBe(before);
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

  const fingerprint = async () =>
    page.evaluate(() =>
      (document.querySelector("canvas") as HTMLCanvasElement).toDataURL().slice(-2000),
    );

  await page.getByRole("button", { name: "pause" }).click();
  await page.waitForTimeout(400);
  const paused = await fingerprint();
  await page.waitForTimeout(900);
  expect(await fingerprint(), "the canvas kept changing while paused").toBe(paused);

  await page.getByRole("button", { name: "play" }).click();
  await page.waitForTimeout(900);
  expect(await fingerprint(), "play did not resume").not.toBe(paused);
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

  // Locator.fill() dispatches "input" then "change" synchronously on a range input. The
  // "input" seeks to the target value, but React's controlled-input re-render reverts the
  // input's DOM value before "change" fires, so "change" replays the onChange handler against
  // that reverted, stale value and the seek lands the video back near zero. A single native
  // "input" event, which is what a real drag fires, only triggers the first half of that and
  // avoids the replay. A paused seek does fire timeupdate and does reach React state, so this is
  // a quirk of fill() on a controlled range input, not an app bug: seekTo deliberately does not
  // also call setPosition.
  const seekWhilePaused = (seconds: number) =>
    page.locator(".seek").evaluate((input: HTMLInputElement, value: number) => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(input, String(value));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, seconds);

  await seekWhilePaused(2);
  await expect(page.locator(".clock")).toContainText("0:02");
  await page.getByRole("button", { name: "set in", exact: true }).click();

  await seekWhilePaused(7);
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
