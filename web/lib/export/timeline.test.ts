import { describe, expect, it } from "vitest";
import { estimatedBytes, exceedsCeiling, fpsFor, frameTimestamps, GIF_MAX_BYTES } from "./timeline";

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
  // estimatedBytes takes output pixel dimensions, not cell counts: GIF bytes track pixel area,
  // and the columns control barely moves that (see GIF_BYTES_PER_PIXEL's comment in timeline.ts
  // for the per-cell model that got this wrong the first time).
  it("grows with the frame count and with the pixel area", () => {
    const small = estimatedBytes("gif", 12, 800, 240);
    expect(estimatedBytes("gif", 24, 800, 240)).toBeGreaterThan(small);
    expect(estimatedBytes("gif", 12, 1600, 480)).toBeGreaterThan(small);
  });

  it("puts a long GIF over the ceiling and a short one under it", () => {
    // 1100x620 is a real measured export size (110 columns), reused rather than an arbitrary
    // resolution: see the calibration pin test below for where it came from.
    expect(exceedsCeiling("gif", estimatedBytes("gif", 12, 1100, 620))).toBe(false);
    expect(exceedsCeiling("gif", estimatedBytes("gif", 200, 1100, 620))).toBe(true);
  });

  it("does not cap MP4, which is small enough to leave alone", () => {
    expect(exceedsCeiling("mp4", GIF_MAX_BYTES * 10)).toBe(false);
  });

  describe("calibration", () => {
    // Real GIF exports of big-buck-bunny.mp4, measured 2026-09-09 (development-log.md has the
    // full story, including the per-cell model this replaced, which was off by up to 79x). This
    // pins the pixel-area model against the exact three points it was calibrated from, so a
    // future constant tweak cannot silently walk the estimate away from reality the way the
    // first model did without anyone noticing until a second column count was tried.
    const measuredExports = [
      { columns: 110, width: 1100, height: 620, frameCount: 12, actualBytes: 1_752_921 },
      { columns: 60, width: 1140, height: 646, frameCount: 12, actualBytes: 1_310_981 },
      { columns: 110, width: 1100, height: 620, frameCount: 60, actualBytes: 8_050_633 },
    ];

    // The constant is calibrated to the top of the measured per-pixel range on purpose (see its
    // comment in timeline.ts), so it overestimates most at the point with the lowest true rate,
    // the 60-column case, which lands at 42% over rather than inside a stricter 40% band. A
    // uniform 45% tolerance covers all three real points without loosening enough to let a
    // badly wrong model through: the old per-cell model missed these by 13x to 79x, nowhere
    // close to this band either way.
    const TOLERANCE = 0.45;

    it.each(measuredExports)(
      "predicts $columns columns ($width x $height, $frameCount frames) within 45% of the measured size",
      ({ width, height, frameCount, actualBytes }) => {
        const estimate = estimatedBytes("gif", frameCount, width, height);
        expect(estimate).toBeGreaterThan(actualBytes * (1 - TOLERANCE));
        expect(estimate).toBeLessThan(actualBytes * (1 + TOLERANCE));
      },
    );
  });
});
