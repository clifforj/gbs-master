/**
 * Shared 2bpp tile conversion utilities for Game Boy graphics.
 *
 * GB 2bpp format: each 8x8 tile is 16 bytes (2 bytes per pixel row).
 * For each row, a lo byte and hi byte encode the shade of each pixel:
 *   shade 0 -> lo=0, hi=0
 *   shade 1 -> lo=1, hi=0
 *   shade 2 -> lo=0, hi=1
 *   shade 3 -> lo=1, hi=1
 */

import type { ParsedPng } from "./png.js";

/**
 * Convert one 8x8 tile from a shade array to GB 2bpp format (16 bytes).
 * shade 0 -> lo=0,hi=0; shade 1 -> lo=1,hi=0; shade 2 -> lo=0,hi=1; shade 3 -> lo=1,hi=1
 */
export function shadesToGb2bpp(shades: Uint8Array, width: number, tileX: number, tileY: number): Uint8Array {
  const out = new Uint8Array(16);
  let off = 0;
  for (let py = 0; py < 8; py++) {
    let lo = 0, hi = 0;
    for (let px = 0; px < 8; px++) {
      const shade = shades[(tileY + py) * width + (tileX + px)];
      const bit = 0x80 >> px;
      if (shade & 1) lo |= bit;
      if (shade & 2) hi |= bit;
    }
    out[off++] = lo;
    out[off++] = hi;
  }
  return out;
}

/**
 * Extract multiple 8x8 tiles from a parsed PNG sheet in row-major order.
 * firstTile: index of first tile to extract (0-based, in grid order)
 * count: number of tiles to extract
 * cols: number of tile columns in the sheet
 */
export function extractTilesFromSheet(
  png: ParsedPng, firstTile: number, count: number, cols: number
): Uint8Array {
  const out = new Uint8Array(count * 16);
  for (let t = 0; t < count; t++) {
    const absIdx = firstTile + t;
    const tileCol = absIdx % cols;
    const tileRow = Math.floor(absIdx / cols);
    const tile = shadesToGb2bpp(png.shades, png.width, tileCol * 8, tileRow * 8);
    out.set(tile, t * 16);
  }
  return out;
}
