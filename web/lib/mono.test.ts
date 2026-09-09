import { describe, expect, it } from "vitest";
import { glyphForLuminance, luminance, MONO_GLYPH_RAMP } from "./ascii";
import { MONO_INKS, monoTreatment, rampForInk, type MonoInk } from "./mono";

/** Luminance of a #rrggbb literal, so a treatment's contrast can be asserted rather than eyeballed. */
function hexLuminance(hex: string): number {
  const value = parseInt(hex.slice(1), 16);
  return luminance((value >> 16) & 255, (value >> 8) & 255, value & 255);
}

describe("rampForInk", () => {
  it("paints dark pixels with dense glyphs in reverse, not with blanks", () => {
    const reversed = rampForInk(MONO_GLYPH_RAMP, "reverse");
    // Ink is dark on light paper, so no light at all has to mean the most ink, not the least.
    expect(glyphForLuminance(0, reversed)).toBe(MONO_GLYPH_RAMP.at(-1));
    expect(glyphForLuminance(255, reversed)).toBe(MONO_GLYPH_RAMP[0]);
  });

  it("leaves the ramp alone for the treatments that light glyphs on a dark ground", () => {
    expect(rampForInk(MONO_GLYPH_RAMP, "amber")).toBe(MONO_GLYPH_RAMP);
    expect(rampForInk(MONO_GLYPH_RAMP, "white")).toBe(MONO_GLYPH_RAMP);
  });

  it("reverses any ramp it is given, not just the built-in one", () => {
    expect(rampForInk(" .oO@", "reverse")).toBe("@Oo. ");
  });
});

describe("monoTreatment", () => {
  it("keeps every treatment's glyphs legible against its own ground", () => {
    // A pressed control once painted amber on amber and the label vanished. Same class of bug.
    for (const ink of MONO_INKS) {
      const { ground, glyph } = monoTreatment(ink);
      const separation = Math.abs(hexLuminance(ground) - hexLuminance(glyph));
      expect(separation, `${ink} has too little contrast`).toBeGreaterThan(64);
    }
  });

  it("gives reverse the only light ground", () => {
    const lightGrounded = MONO_INKS.filter(
      (ink: MonoInk) => hexLuminance(monoTreatment(ink).ground) > 127,
    );
    expect(lightGrounded).toEqual(["reverse"]);
  });
});
