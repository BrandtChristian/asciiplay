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
