import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { shadesToGb2bpp, extractTilesFromSheet } from "./tiles.js";
import type { ParsedPng } from "./png.js";

describe("shadesToGb2bpp", () => {
  it("converts all-white (shade 0) 8x8 tile to 16 bytes of 0x00", () => {
    const shades = new Uint8Array(64); // all zeros = shade 0
    const result = shadesToGb2bpp(shades, 8, 0, 0);
    assert.equal(result.length, 16);
    for (let i = 0; i < 16; i++) {
      assert.equal(result[i], 0x00, `byte ${i}`);
    }
  });

  it("converts all-black (shade 3) 8x8 tile to alternating 0xFF pairs", () => {
    const shades = new Uint8Array(64).fill(3);
    const result = shadesToGb2bpp(shades, 8, 0, 0);
    assert.equal(result.length, 16);
    // shade 3 -> lo=1, hi=1 for every pixel => lo=0xFF, hi=0xFF per row
    for (let row = 0; row < 8; row++) {
      assert.equal(result[row * 2], 0xFF, `lo byte row ${row}`);
      assert.equal(result[row * 2 + 1], 0xFF, `hi byte row ${row}`);
    }
  });

  it("converts single shade 1 pixel at (0,0) correctly", () => {
    // shade 1 -> lo=1, hi=0. Pixel (0,0) is bit 7 (0x80).
    const shades = new Uint8Array(64); // all shade 0
    shades[0] = 1; // top-left pixel
    const result = shadesToGb2bpp(shades, 8, 0, 0);
    // Row 0: lo=0x80, hi=0x00. All other rows: 0x00, 0x00
    assert.equal(result[0], 0x80); // lo
    assert.equal(result[1], 0x00); // hi
    for (let i = 2; i < 16; i++) {
      assert.equal(result[i], 0x00, `byte ${i}`);
    }
  });

  it("converts single shade 2 pixel at (0,0) correctly", () => {
    // shade 2 -> lo=0, hi=1. Pixel (0,0) is bit 7 (0x80).
    const shades = new Uint8Array(64);
    shades[0] = 2;
    const result = shadesToGb2bpp(shades, 8, 0, 0);
    assert.equal(result[0], 0x00); // lo
    assert.equal(result[1], 0x80); // hi
    for (let i = 2; i < 16; i++) {
      assert.equal(result[i], 0x00, `byte ${i}`);
    }
  });

  it("handles tile offset within a wider image", () => {
    // 16px wide image, extract tile at column 8 (tileX=8)
    const shades = new Uint8Array(16 * 8); // 16 wide, 8 tall
    shades[0 * 16 + 8] = 3; // pixel (8,0) of the image = pixel (0,0) of tile 1
    const result = shadesToGb2bpp(shades, 16, 8, 0);
    assert.equal(result[0], 0x80); // lo bit 7 set (shade 3 has lo=1)
    assert.equal(result[1], 0x80); // hi bit 7 set (shade 3 has hi=1)
  });
});

describe("extractTilesFromSheet", () => {
  it("extracts two tiles from a 16x8 sheet", () => {
    // 16x8 = 2 tile columns, 1 tile row
    const shades = new Uint8Array(16 * 8);
    // Fill first tile (left 8x8) with shade 1
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        shades[y * 16 + x] = 1;
      }
    }
    // Fill second tile (right 8x8) with shade 2
    for (let y = 0; y < 8; y++) {
      for (let x = 8; x < 16; x++) {
        shades[y * 16 + x] = 2;
      }
    }

    const png: ParsedPng = { width: 16, height: 8, shades };
    const result = extractTilesFromSheet(png, 0, 2, 2);
    assert.equal(result.length, 32); // 2 tiles * 16 bytes

    // Tile 0: all shade 1 -> lo=0xFF, hi=0x00 per row
    for (let row = 0; row < 8; row++) {
      assert.equal(result[row * 2], 0xFF, `tile0 lo row ${row}`);
      assert.equal(result[row * 2 + 1], 0x00, `tile0 hi row ${row}`);
    }

    // Tile 1: all shade 2 -> lo=0x00, hi=0xFF per row
    for (let row = 0; row < 8; row++) {
      assert.equal(result[16 + row * 2], 0x00, `tile1 lo row ${row}`);
      assert.equal(result[16 + row * 2 + 1], 0xFF, `tile1 hi row ${row}`);
    }
  });

  it("extracts a subset of tiles using firstTile offset", () => {
    // 16x8 sheet, extract only the second tile
    const shades = new Uint8Array(16 * 8).fill(0);
    // Fill second tile with shade 3
    for (let y = 0; y < 8; y++) {
      for (let x = 8; x < 16; x++) {
        shades[y * 16 + x] = 3;
      }
    }

    const png: ParsedPng = { width: 16, height: 8, shades };
    const result = extractTilesFromSheet(png, 1, 1, 2);
    assert.equal(result.length, 16);

    // All shade 3 -> 0xFF, 0xFF per row
    for (let row = 0; row < 8; row++) {
      assert.equal(result[row * 2], 0xFF, `lo row ${row}`);
      assert.equal(result[row * 2 + 1], 0xFF, `hi row ${row}`);
    }
  });
});
