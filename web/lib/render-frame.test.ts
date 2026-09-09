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
