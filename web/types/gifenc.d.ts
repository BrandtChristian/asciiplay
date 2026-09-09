// gifenc ships no TypeScript types (and @types/gifenc does not exist), so this project
// declares only the surface it actually calls. Signatures are read from
// node_modules/gifenc/src/{index,pnnquant2,palettize}.js, not guessed.
declare module "gifenc" {
  /** An [r, g, b] or [r, g, b, a] palette entry. */
  type GifPaletteColor = number[];

  interface GifWriteFrameOptions {
    palette?: GifPaletteColor[];
    delay?: number;
    transparent?: boolean;
    transparentIndex?: number;
    repeat?: number;
    colorDepth?: number;
    dispose?: number;
  }

  interface GifEncoderHandle {
    writeFrame(
      indexedPixels: Uint8Array,
      width: number,
      height: number,
      options?: GifWriteFrameOptions,
    ): void;
    finish(): void;
    // Pinned to the ArrayBuffer-backed overload, not the default ArrayBufferLike one: gifenc's
    // stream never uses a SharedArrayBuffer, and BlobPart needs the pinned form to accept it.
    bytesView(): Uint8Array<ArrayBuffer>;
  }

  export function GIFEncoder(options?: {
    initialCapacity?: number;
    auto?: boolean;
  }): GifEncoderHandle;

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
  ): GifPaletteColor[];

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: GifPaletteColor[],
  ): Uint8Array;
}
