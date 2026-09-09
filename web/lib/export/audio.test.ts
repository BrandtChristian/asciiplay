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
