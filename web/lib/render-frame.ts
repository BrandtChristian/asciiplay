import { buildGlyphRows, fitLayout, type Layout, type RenderMode } from "./ascii";
import { monoTreatment, rampForInk, type MonoInk } from "./mono";

/** Below this a cell is not a glyph any more, and the font size collapses. */
const MINIMUM_CELL_WIDTH = 3;

/**
 * Cell width in whole pixels.
 *
 * Whole pixels are not a nicety: the glyph advance has to equal the cell width exactly, or a
 * row drawn with a single fillText drifts out of step with the colour grid it is multiplied
 * against, and the picture shears further to the right on every column.
 */
export function cellWidthFor(availableWidth: number, columns: number): number {
  return Math.max(MINIMUM_CELL_WIDTH, Math.floor(availableWidth / columns));
}

/**
 * Pixel size of a rendered cell grid. Cell height is always double cell width (the half-block
 * aspect ratio), the same relationship `renderFrame` below uses for `cssWidth`/`cssHeight`; this
 * is the export-side equivalent, needed wherever export dimensions are computed without a full
 * render (the size estimate) as well as where they are (the actual encoders).
 */
export function pixelSizeFor(
  cellColumns: number,
  cellRows: number,
  cellWidth: number,
): { width: number; height: number } {
  return { width: cellColumns * cellWidth, height: cellRows * cellWidth * 2 };
}

export interface FrameCanvases {
  display: HTMLCanvasElement;
  glyph: HTMLCanvasElement;
  sample: HTMLCanvasElement;
}

export function createFrameCanvases(display: HTMLCanvasElement): FrameCanvases {
  return {
    display,
    glyph: document.createElement("canvas"),
    sample: document.createElement("canvas"),
  };
}

export interface RenderRequest {
  source: CanvasImageSource;
  sourceWidth: number;
  sourceHeight: number;
  mode: RenderMode;
  monoInk: MonoInk;
  charsetRamp: string;
  columns: number;
  /** Device pixels per cell. The preview scales by devicePixelRatio; export passes 1. */
  cellWidth: number;
  pixelRatio: number;
}

export interface RenderedFrame {
  layout: Layout;
  rows: string[];
  pixels: Uint8ClampedArray;
  /** The effective ramp, reversed for reverse ink, so encodeAnsi agrees with the canvas. */
  ramp: string;
  cssWidth: number;
  cssHeight: number;
}

export function renderFrame(canvases: FrameCanvases, request: RenderRequest): RenderedFrame | null {
  const { display, glyph, sample } = canvases;
  const displayContext = display.getContext("2d");
  const sampleContext = sample.getContext("2d", { willReadFrequently: true });
  const glyphContext = glyph.getContext("2d");
  if (!displayContext || !sampleContext || !glyphContext) return null;

  const { mode, monoInk, columns, cellWidth, pixelRatio } = request;
  const treatment = monoTreatment(monoInk);
  const ramp = mode === "mono" ? rampForInk(request.charsetRamp, monoInk) : request.charsetRamp;

  const cellHeight = cellWidth * 2;
  const layout = fitLayout(columns, request.sourceWidth, request.sourceHeight, mode);
  const cssWidth = layout.cellColumns * cellWidth;
  const cssHeight = layout.cellRows * cellHeight;

  displayContext.font = `100px ui-monospace, monospace`;
  const advanceRatio = displayContext.measureText("M").width / 100;
  const fontSize = cellWidth / advanceRatio;

  if (display.width !== cssWidth * pixelRatio || display.height !== cssHeight * pixelRatio) {
    for (const canvas of [display, glyph]) {
      canvas.width = cssWidth * pixelRatio;
      canvas.height = cssHeight * pixelRatio;
    }
  }
  if (sample.width !== layout.pixelWidth || sample.height !== layout.pixelHeight) {
    sample.width = layout.pixelWidth;
    sample.height = layout.pixelHeight;
  }

  // One cell per pixel: the browser's own scaler does the downscaling for free.
  sampleContext.drawImage(request.source, 0, 0, layout.pixelWidth, layout.pixelHeight);
  const pixels = sampleContext.getImageData(0, 0, layout.pixelWidth, layout.pixelHeight).data;

  displayContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  displayContext.globalCompositeOperation = "source-over";
  displayContext.fillStyle = mode === "mono" ? treatment.ground : "#000";
  displayContext.fillRect(0, 0, cssWidth, cssHeight);

  let rows: string[] = [];
  if (mode === "blocks") {
    // Half blocks are just the cell grid at double vertical resolution, so nearest neighbour
    // upscaling of the sample IS the mode. No glyphs involved.
    displayContext.imageSmoothingEnabled = false;
    displayContext.drawImage(sample, 0, 0, cssWidth, cssHeight);
  } else {
    rows = buildGlyphRows(pixels, layout, mode, ramp);
    const target = mode === "mono" ? displayContext : glyphContext;
    if (mode !== "mono") {
      glyphContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      glyphContext.fillStyle = "#000";
      glyphContext.fillRect(0, 0, cssWidth, cssHeight);
    }
    target.font = `${fontSize}px ui-monospace, monospace`;
    target.textBaseline = "middle";
    target.fillStyle = mode === "mono" ? treatment.glyph : "#fff";
    for (let row = 0; row < rows.length; row += 1) {
      // One call per row rather than per cell: about 40 draws a frame instead of 4000.
      target.fillText(rows[row], 0, row * cellHeight + cellHeight / 2);
    }
    if (mode !== "mono") {
      // White glyphs times the per-cell colour field gives glyph shaped colour, and needs one
      // composite rather than a fillStyle change per run.
      displayContext.drawImage(glyph, 0, 0, cssWidth, cssHeight);
      displayContext.globalCompositeOperation = "multiply";
      displayContext.imageSmoothingEnabled = false;
      displayContext.drawImage(sample, 0, 0, cssWidth, cssHeight);
      displayContext.globalCompositeOperation = "source-over";
    }
  }

  return { layout, rows, pixels, ramp, cssWidth, cssHeight };
}
