// The browser half of asciiplay. Deliberately the same maths as the Rust encoder in
// ../../src/render.rs: same luma weights, same ramps, same layout rule, same tolerance based
// run collapsing. Where the two differ it is a bug in one of them.

/** A terminal cell is about twice as tall as it is wide, and the canvas grid mimics that. */
export const CELL_HEIGHT_OVER_WIDTH = 2;

/** Colour carries the picture, so a dense ramp only adds noise. Ten levels, dark to light. */
export const COLOUR_GLYPH_RAMP = " .:-=+*#%@";

/** In mono the glyph is the only channel there is, so the long ramp earns its keep. */
export const MONO_GLYPH_RAMP =
  " .`^\":;!~+?][}{)(|\\/tfjrxnuvczYUJCLQ0Zmwqpdbkhao*#MW&8%B@$";

/**
 * How far two colours may drift before a new escape is emitted.
 *
 * Measured on real footage: adjacent cells share an exact RGB triple only about 1 percent of
 * the time once a frame is downscaled, because each cell averages order a hundred source
 * pixels. Exact matching therefore saves almost nothing, while a tolerance of 8 collapses most
 * neighbours for a mean channel error around 2/255.
 */
export const DEFAULT_COLOUR_TOLERANCE = 8;

// Rec. 709 luma in 8 bit fixed point. These sum to exactly 256, which is what makes pure white
// land on exactly 255 rather than 254.
const LUMA_WEIGHT_RED = 54;
const LUMA_WEIGHT_GREEN = 183;
const LUMA_WEIGHT_BLUE = 19;
const LUMA_SHIFT = 8;

export type RenderMode = "colour" | "mono" | "blocks";

export interface Layout {
  cellColumns: number;
  cellRows: number;
  /** Width of the pixel grid asked of the sampling canvas. */
  pixelWidth: number;
  /** Height of the pixel grid. Twice cellRows in blocks mode, where a cell holds two pixels. */
  pixelHeight: number;
}

export function verticalPixelsPerCell(mode: RenderMode): number {
  return mode === "blocks" ? 2 : 1;
}

export function glyphRamp(mode: RenderMode): string {
  return mode === "mono" ? MONO_GLYPH_RAMP : COLOUR_GLYPH_RAMP;
}

export function luminance(red: number, green: number, blue: number): number {
  return (
    (LUMA_WEIGHT_RED * red + LUMA_WEIGHT_GREEN * green + LUMA_WEIGHT_BLUE * blue) >> LUMA_SHIFT
  );
}

export function glyphForLuminance(level: number, ramp: string): string {
  // level maxes at 255, so this can never reach ramp.length and never needs clamping.
  return ramp[(level * ramp.length) >> LUMA_SHIFT];
}

/**
 * Fit a source of the given dimensions into a grid at most `maxColumns` wide, preserving
 * aspect ratio.
 *
 * The cell grid is the same in every mode, because that is a property of the display area
 * rather than of how a cell gets painted. Only the sampled pixel grid changes.
 */
export function fitLayout(
  maxColumns: number,
  sourceWidth: number,
  sourceHeight: number,
  mode: RenderMode,
  cellHeightOverWidth = CELL_HEIGHT_OVER_WIDTH,
): Layout {
  const columns = Math.max(2, Math.floor(maxColumns));
  const sourceAspect = sourceWidth / sourceHeight;
  const rows = Math.max(2, Math.round(columns / (sourceAspect * cellHeightOverWidth)));
  return {
    cellColumns: columns,
    cellRows: rows,
    pixelWidth: columns,
    pixelHeight: rows * verticalPixelsPerCell(mode),
  };
}

/**
 * One string per cell row, for drawing with a single fillText per row.
 *
 * Drawing a row at a time rather than a cell at a time is the difference between about 40
 * canvas calls per frame and about 4000, which is what makes this hold a frame rate at all.
 */
export function buildGlyphRows(pixels: Uint8ClampedArray, layout: Layout, mode: RenderMode): string[] {
  const ramp = glyphRamp(mode);
  const rows: string[] = [];
  const perCell = verticalPixelsPerCell(mode);
  for (let row = 0; row < layout.cellRows; row += 1) {
    let line = "";
    for (let column = 0; column < layout.cellColumns; column += 1) {
      const offset = ((row * perCell * layout.pixelWidth) + column) * 4;
      line += glyphForLuminance(
        luminance(pixels[offset], pixels[offset + 1], pixels[offset + 2]),
        ramp,
      );
    }
    rows.push(line);
  }
  return rows;
}

function beyondTolerance(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  tolerance: number,
): boolean {
  return (
    Math.abs(a[0] - b[0]) > tolerance ||
    Math.abs(a[1] - b[1]) > tolerance ||
    Math.abs(a[2] - b[2]) > tolerance
  );
}

/**
 * The same frame as an ANSI escape string, which is what the .cast export and the clipboard
 * need. Row addressed absolutely, exactly as the terminal encoder does, so a recorded cast
 * replays identically to the real player.
 */
export function encodeAnsi(
  pixels: Uint8ClampedArray,
  layout: Layout,
  mode: RenderMode,
  tolerance = DEFAULT_COLOUR_TOLERANCE,
): string {
  const ramp = glyphRamp(mode);
  const perCell = verticalPixelsPerCell(mode);
  const parts: string[] = [];

  for (let row = 0; row < layout.cellRows; row += 1) {
    parts.push(`\x1b[${row + 1};1H`);
    // Run state resets each row so no row inherits a colour from the one above it.
    let lastForeground: [number, number, number] | null = null;
    let lastBackground: [number, number, number] | null = null;

    for (let column = 0; column < layout.cellColumns; column += 1) {
      const top = ((row * perCell * layout.pixelWidth) + column) * 4;
      const colour: [number, number, number] = [pixels[top], pixels[top + 1], pixels[top + 2]];

      if (mode === "mono") {
        parts.push(glyphForLuminance(luminance(colour[0], colour[1], colour[2]), ramp));
        continue;
      }

      if (mode === "blocks") {
        const bottom = top + layout.pixelWidth * 4;
        const under: [number, number, number] = [
          pixels[bottom],
          pixels[bottom + 1],
          pixels[bottom + 2],
        ];
        if (!lastForeground || beyondTolerance(colour, lastForeground, tolerance)) {
          parts.push(`\x1b[38;2;${colour[0]};${colour[1]};${colour[2]}m`);
          lastForeground = colour;
        }
        if (!lastBackground || beyondTolerance(under, lastBackground, tolerance)) {
          parts.push(`\x1b[48;2;${under[0]};${under[1]};${under[2]}m`);
          lastBackground = under;
        }
        parts.push("▀");
        continue;
      }

      if (!lastForeground || beyondTolerance(colour, lastForeground, tolerance)) {
        parts.push(`\x1b[38;2;${colour[0]};${colour[1]};${colour[2]}m`);
        lastForeground = colour;
      }
      parts.push(glyphForLuminance(luminance(colour[0], colour[1], colour[2]), ramp));
    }
  }

  // Reset once per frame, never per cell.
  if (mode !== "mono") parts.push("\x1b[0m");
  return parts.join("");
}

export interface CastFrame {
  /** Seconds since recording started. */
  time: number;
  data: string;
}

/**
 * An asciinema v2 cast file, which is newline delimited JSON: a header object, then one
 * [time, "o", data] triple per frame. `asciinema play out.cast` replays it in a real terminal.
 */
export function buildCastFile(frames: CastFrame[], layout: Layout, title: string): string {
  const header = {
    version: 2,
    width: layout.cellColumns,
    height: layout.cellRows,
    timestamp: Math.floor(Date.now() / 1000),
    title,
    env: { TERM: "xterm-256color" },
  };
  const lines = [JSON.stringify(header)];
  // Hide the cursor and clear once up front, the same way the player enters its screen.
  lines.push(JSON.stringify([0, "o", "\x1b[?25l\x1b[2J"]));
  for (const frame of frames) {
    lines.push(JSON.stringify([frame.time, "o", frame.data]));
  }
  // Leave the terminal as we found it, or the viewer is left with no cursor.
  const end = frames.length > 0 ? frames[frames.length - 1].time + 0.1 : 0.1;
  lines.push(JSON.stringify([end, "o", "\x1b[0m\x1b[?25h\r\n"]));
  return lines.join("\n") + "\n";
}

/** Plain text of one frame, for the clipboard. Newlines instead of cursor addressing. */
export function toPlainText(rows: string[]): string {
  return rows.join("\n") + "\n";
}
