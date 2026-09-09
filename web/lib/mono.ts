/**
 * The mono treatments: what colour the glyphs are and what they sit on.
 *
 * This is deliberately a separate axis from `RenderMode` rather than three more members of it.
 * Mode is switched on in eight places across the layout, glyph and ANSI code, none of which
 * care what colour the result gets painted, so widening it would mean auditing all eight to
 * make no difference.
 */
export const MONO_INKS = ["amber", "white", "reverse"] as const;

export type MonoInk = (typeof MONO_INKS)[number];

export interface MonoTreatment {
  /** What the control is called. Lives here so the list and the labels cannot drift apart. */
  label: string;
  /** Six digit hex, because the tests read the channels back out of it. */
  ground: string;
  glyph: string;
  /**
   * Ink on paper rather than light on a screen. The CRT scanline overlay is suppressed over
   * paper, where it multiplies into visible grey banding instead of vanishing into black.
   */
  paper: boolean;
}

const TREATMENTS: Record<MonoInk, MonoTreatment> = {
  amber: { label: "amber", ground: "#000000", glyph: "#ffb454", paper: false },
  white: { label: "b&w", ground: "#000000", glyph: "#ffffff", paper: false },
  reverse: { label: "reverse", ground: "#ffffff", glyph: "#000000", paper: true },
};

export function monoTreatment(ink: MonoInk): MonoTreatment {
  return TREATMENTS[ink];
}

/**
 * The ramp to actually render with.
 *
 * A ramp runs darkest first, so its first glyph is a blank. That is correct while the glyph is
 * light and the ground is dark: no light means no ink. On paper it is exactly backwards, and
 * the darkest part of the picture would come out as untouched white. Reversing the ramp is what
 * makes ink behave like ink, and it is the difference between reverse mode and a photographic
 * negative.
 */
export function rampForInk(ramp: string, ink: MonoInk): string {
  return ink === "reverse" ? [...ramp].reverse().join("") : ramp;
}
