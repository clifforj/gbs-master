/**
 * PNG parser — reads indexed 4-bit/8-bit, RGB 8-bit, or RGBA 8-bit PNGs
 * and produces a shade array (0-3) using the GBStudio Classic palette mapping.
 */

import { inflateSync } from "zlib";

export interface ParsedPng {
  width: number;
  height: number;
  /** shades[y * width + x] = GB shade 0-3 (already mapped from pixel color). */
  shades: Uint8Array;
}

export function parsePng(buf: Buffer, filename = "font PNG"): ParsedPng {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== SIG[i]) throw new Error("Not a valid PNG file");
  }

  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const palette: [number, number, number][] = [];
  const idatChunks: Buffer[] = [];
  let offset = 8;

  while (offset + 12 <= buf.length) {
    const chunkLen  = buf.readUInt32BE(offset);
    const chunkType = buf.slice(offset + 4, offset + 8).toString("ascii");
    const chunkData = buf.slice(offset + 8, offset + 8 + chunkLen);
    offset += 12 + chunkLen;

    if (chunkType === "IHDR") {
      width     = chunkData.readUInt32BE(0);
      height    = chunkData.readUInt32BE(4);
      bitDepth  = chunkData[8];
      colorType = chunkData[9];
    } else if (chunkType === "PLTE") {
      for (let i = 0; i + 2 < chunkLen; i += 3) {
        palette.push([chunkData[i], chunkData[i + 1], chunkData[i + 2]]);
      }
    } else if (chunkType === "IDAT") {
      idatChunks.push(Buffer.from(chunkData));
    } else if (chunkType === "IEND") {
      break;
    }
  }

  // Supported: indexed 4-bit or 8-bit (colorType=3), RGB 8-bit (colorType=2),
  // or RGBA 8-bit (colorType=6).
  const isIndexed4 = colorType === 3 && bitDepth === 4;
  const isIndexed8 = colorType === 3 && bitDepth === 8;
  const isRgb8     = colorType === 2 && bitDepth === 8;
  const isRgba8    = colorType === 6 && bitDepth === 8;
  if (!isIndexed4 && !isIndexed8 && !isRgb8 && !isRgba8) {
    throw new Error(
      `${filename}: unsupported PNG format (colorType=${colorType}, bitDepth=${bitDepth}). ` +
        `Expected indexed 4-bit (3/4), indexed 8-bit (3/8), RGB 8-bit (2/8), or RGBA 8-bit (6/8).`
    );
  }

  const raw = inflateSync(Buffer.concat(idatChunks));

  // bytesPerPixel for the filter algorithm: 1 for indexed, 3 for RGB, 4 for RGBA.
  const bpp    = isRgba8 ? 4 : isRgb8 ? 3 : 1;
  const stride = isIndexed4 ? Math.ceil(width / 2) : (isIndexed8 ? width : (isRgb8 ? width * 3 : width * 4));

  const shades = new Uint8Array(width * height);
  let prevRow = new Uint8Array(stride);
  let rawOff = 0;

  for (let row = 0; row < height; row++) {
    const filterType = raw[rawOff++];
    const filtered = raw.slice(rawOff, rawOff + stride);
    rawOff += stride;

    const recon = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const left      = i >= bpp ? recon[i - bpp] : 0;
      const above     = prevRow[i];
      const aboveLeft = i >= bpp ? prevRow[i - bpp] : 0;
      let r: number;
      switch (filterType) {
        case 0: r = filtered[i]; break;
        case 1: r = filtered[i] + left; break;
        case 2: r = filtered[i] + above; break;
        case 3: r = filtered[i] + Math.floor((left + above) / 2); break;
        case 4: r = filtered[i] + paethPredictor(left, above, aboveLeft); break;
        default: throw new Error(`Unknown PNG filter type ${filterType} at row ${row}`);
      }
      recon[i] = r & 0xff;
    }

    const base = row * width;
    if (isIndexed4) {
      for (let col = 0; col < width; col++) {
        const byte = recon[col >> 1];
        const idx = (col & 1) === 0 ? (byte >> 4) & 0xf : byte & 0xf;
        const [r, g, b] = palette[idx];
        shades[base + col] = gbShadeFromPaletteEntry(r, g, b);
      }
    } else if (isIndexed8) {
      for (let col = 0; col < width; col++) {
        const idx = recon[col];
        const [r, g, b] = palette[idx];
        shades[base + col] = gbShadeFromPaletteEntry(r, g, b);
      }
    } else if (isRgb8) {
      // RGB: 3 bytes per pixel (R, G, B). No alpha channel.
      for (let col = 0; col < width; col++) {
        const i = col * 3;
        shades[base + col] = gbShadeFromPaletteEntry(recon[i], recon[i + 1], recon[i + 2]);
      }
    } else {
      // RGBA: 4 bytes per pixel (R, G, B, A). Treat A < 128 as transparent (shade 0).
      for (let col = 0; col < width; col++) {
        const i = col * 4;
        const a = recon[i + 3];
        shades[base + col] = a < 128
          ? 0
          : gbShadeFromPaletteEntry(recon[i], recon[i + 1], recon[i + 2]);
      }
    }

    prevRow = recon;
  }

  return { width, height, shades };
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Map a GBStudio GB Classic palette color to a GB shade (0-3).
 *
 * GBStudio Classic palette shades (identified by green channel threshold):
 *   #E0F8CF (G=248) -> shade 0  (white / cell background)
 *   #87C06A (G=192) -> shade 1  (light gray / anti-aliasing)
 *   #2E6850 (G=104) -> shade 2  (dark gray / secondary ink)
 *   #071821 (G=24)  -> shade 3  (black / primary ink)
 *   #FF00FF         -> shade 0  (magenta = transparent, treated as background)
 *
 * With the standard BGP palette 0xE4 (00=white, 01=lgray, 10=dgray, 11=black),
 * all 4 shades render correctly and the font retains its designed appearance.
 */
export function gbShadeFromPaletteEntry(r: number, g: number, b: number): number {
  if (r > 200 && g < 50 && b > 200) return 0; // magenta = transparent
  if (g > 220) return 0;  // #E0F8CF lightest = white/background
  if (g > 120) return 1;  // #87C06A light gray
  if (g > 50)  return 2;  // #2E6850 dark gray
  return 3;               // #071821 / #000000 black
}
