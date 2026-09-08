import { describe, expect, it } from "vitest";
import {
  buildCastFile,
  buildGlyphRows,
  CHARSET_PRESETS,
  COLOUR_GLYPH_RAMP,
  DEFAULT_COLOUR_TOLERANCE,
  defaultRamp,
  encodeAnsi,
  fitLayout,
  glyphForLuminance,
  luminance,
  MONO_GLYPH_RAMP,
  SHADES_GLYPH_RAMP,
  toPlainText,
  type Layout,
} from "./ascii";

/** RGBA pixel buffer of one solid colour, matching what getImageData returns. */
function solid(width: number, height: number, colour: [number, number, number]) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    pixels[index * 4] = colour[0];
    pixels[index * 4 + 1] = colour[1];
    pixels[index * 4 + 2] = colour[2];
    pixels[index * 4 + 3] = 255;
  }
  return pixels;
}

function layoutOf(columns: number, rows: number, perCell = 1): Layout {
  return {
    cellColumns: columns,
    cellRows: rows,
    pixelWidth: columns,
    pixelHeight: rows * perCell,
  };
}

describe("luminance", () => {
  // These must match src/render.rs exactly. If one side changes, the two renderers diverge.
  it("is exact at the endpoints", () => {
    expect(luminance(0, 0, 0)).toBe(0);
    expect(luminance(255, 255, 255)).toBe(255);
    expect(luminance(255, 0, 0)).toBe(53);
    expect(luminance(0, 255, 0)).toBe(182);
    expect(luminance(0, 0, 255)).toBe(18);
  });

  it("never leaves the ramp, for any ramp", () => {
    for (const ramp of [COLOUR_GLYPH_RAMP, MONO_GLYPH_RAMP, SHADES_GLYPH_RAMP]) {
      for (let level = 0; level <= 255; level += 1) {
        expect(ramp).toContain(glyphForLuminance(level, ramp));
      }
      expect(glyphForLuminance(0, ramp)).toBe(ramp[0]);
      expect(glyphForLuminance(255, ramp)).toBe(ramp[ramp.length - 1]);
    }
  });
});

describe("charsets", () => {
  it("shades is Block Elements, all one cell wide", () => {
    expect([...SHADES_GLYPH_RAMP]).toEqual([" ", "░", "▒", "▓", "█"]);
  });

  it("presets are the same three the CLI offers", () => {
    expect(Object.keys(CHARSET_PRESETS)).toEqual(["ascii", "long", "shades"]);
  });

  it("mono defaults to the long ramp and colour to the short one", () => {
    expect(defaultRamp("mono")).toBe(MONO_GLYPH_RAMP);
    expect(defaultRamp("colour")).toBe(COLOUR_GLYPH_RAMP);
    expect(defaultRamp("blocks")).toBe(COLOUR_GLYPH_RAMP);
  });
});

describe("fitLayout", () => {
  it("preserves aspect ratio through the 2:1 cell", () => {
    const layout = fitLayout(160, 1920, 1080, "colour");
    // 160 / (1.778 * 2) = 45
    expect(layout.cellColumns).toBe(160);
    expect(layout.cellRows).toBe(45);
    const shown = layout.cellColumns / (layout.cellRows * 2);
    expect(shown).toBeCloseTo(1920 / 1080, 1);
  });

  it("gives blocks mode the same cells but twice the pixels", () => {
    const colour = fitLayout(120, 1920, 1080, "colour");
    const blocks = fitLayout(120, 1920, 1080, "blocks");
    expect(blocks.cellColumns).toBe(colour.cellColumns);
    expect(blocks.cellRows).toBe(colour.cellRows);
    expect(blocks.pixelHeight).toBe(colour.pixelHeight * 2);
    expect(blocks.pixelHeight % 2).toBe(0);
  });

  it("never collapses below a usable grid", () => {
    for (const columns of [1, 2, 5, 40, 300]) {
      const layout = fitLayout(columns, 640, 480, "colour");
      expect(layout.cellColumns).toBeGreaterThanOrEqual(2);
      expect(layout.cellRows).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("buildGlyphRows", () => {
  it("returns one string per row at full width", () => {
    const layout = layoutOf(6, 3);
    const rows = buildGlyphRows(solid(6, 3, [255, 255, 255]), layout, "colour", COLOUR_GLYPH_RAMP);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.length === 6)).toBe(true);
    expect(rows[0]).toBe("@@@@@@");
  });

  it("reads only the top pixel of each blocks-mode cell", () => {
    // Two pixel rows per cell row: white on top, black underneath.
    const layout = layoutOf(2, 1, 2);
    const pixels = new Uint8ClampedArray(2 * 2 * 4);
    for (let index = 0; index < 2; index += 1) {
      pixels[index * 4] = pixels[index * 4 + 1] = pixels[index * 4 + 2] = 255;
      pixels[index * 4 + 3] = 255;
    }
    const rows = buildGlyphRows(pixels, layout, "blocks", COLOUR_GLYPH_RAMP);
    expect(rows[0]).toBe("@@");
  });

  it("honours the charset it is given", () => {
    const layout = layoutOf(3, 1);
    const rows = buildGlyphRows(solid(3, 1, [255, 255, 255]), layout, "colour", SHADES_GLYPH_RAMP);
    expect(rows[0]).toBe("███");
  });
});

describe("encodeAnsi", () => {
  it("collapses a solid row to one colour escape", () => {
    const layout = layoutOf(40, 3);
    const ansi = encodeAnsi(solid(40, 3, [10, 120, 250]), layout, "colour", COLOUR_GLYPH_RAMP);
    expect(ansi.match(/\x1b\[38;2;/g)).toHaveLength(3);
  });

  it("emits no colour at all in mono", () => {
    const layout = layoutOf(4, 2);
    const ansi = encodeAnsi(solid(4, 2, [200, 200, 200]), layout, "mono", MONO_GLYPH_RAMP);
    expect(ansi).not.toContain("\x1b[38;2;");
    expect(ansi).not.toContain("\x1b[48;2;");
  });

  it("collapses near colours and keeps distant ones", () => {
    const layout = layoutOf(3, 1);
    const pixels = new Uint8ClampedArray([
      100, 100, 100, 255, 104, 104, 104, 255, 250, 250, 250, 255,
    ]);
    const collapsed = encodeAnsi(pixels, layout, "colour", COLOUR_GLYPH_RAMP);
    expect(collapsed.match(/\x1b\[38;2;/g)).toHaveLength(2);
    const exact = encodeAnsi(pixels, layout, "colour", COLOUR_GLYPH_RAMP, 0);
    expect(exact.match(/\x1b\[38;2;/g)).toHaveLength(3);
  });

  it("pairs two pixel rows into one half block", () => {
    const layout = layoutOf(1, 1, 2);
    const pixels = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]);
    const ansi = encodeAnsi(pixels, layout, "blocks", COLOUR_GLYPH_RAMP);
    expect(ansi).toBe("\x1b[1;1H\x1b[38;2;255;0;0m\x1b[48;2;0;0;255m▀\x1b[0m");
  });

  it("addresses every row absolutely, so nothing relies on wrapping", () => {
    const layout = layoutOf(2, 3);
    const ansi = encodeAnsi(solid(2, 3, [0, 0, 0]), layout, "mono", MONO_GLYPH_RAMP);
    expect(ansi).toContain("\x1b[1;1H");
    expect(ansi).toContain("\x1b[2;1H");
    expect(ansi).toContain("\x1b[3;1H");
    expect(ansi).not.toContain("\n");
  });

  it("defaults to the same tolerance as the CLI", () => {
    expect(DEFAULT_COLOUR_TOLERANCE).toBe(8);
  });
});

describe("buildCastFile", () => {
  it("is newline delimited JSON with an asciinema v2 header", () => {
    const layout = layoutOf(80, 24);
    const cast = buildCastFile(
      [
        { time: 0, data: "\x1b[1;1Hab" },
        { time: 0.04, data: "\x1b[1;1Hcd" },
      ],
      layout,
      "demo.mp4",
    );
    const lines = cast.trimEnd().split("\n");
    const header = JSON.parse(lines[0]);
    expect(header.version).toBe(2);
    expect(header.width).toBe(80);
    expect(header.height).toBe(24);
    expect(header.title).toBe("demo.mp4");

    // Hides the cursor first, restores it last, or the viewer is left without one.
    expect(JSON.parse(lines[1])[2]).toContain("\x1b[?25l");
    expect(JSON.parse(lines[lines.length - 1])[2]).toContain("\x1b[?25h");

    const frames = lines.slice(2, -1).map((line) => JSON.parse(line));
    expect(frames.map((frame) => frame[0])).toEqual([0, 0.04]);
    expect(frames.every((frame) => frame[1] === "o")).toBe(true);
  });

  it("stays valid with no frames recorded", () => {
    const cast = buildCastFile([], layoutOf(10, 4), "empty");
    for (const line of cast.trimEnd().split("\n")) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe("toPlainText", () => {
  it("joins rows with newlines and ends with one", () => {
    expect(toPlainText(["ab", "cd"])).toBe("ab\ncd\n");
  });
});
