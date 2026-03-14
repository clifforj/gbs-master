import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { gbShadeFromPaletteEntry, parsePng } from "./png.js";

describe("gbShadeFromPaletteEntry", () => {
  it("maps magenta (0xFF, 0x00, 0xFF) to shade 0 (transparent)", () => {
    assert.equal(gbShadeFromPaletteEntry(0xFF, 0x00, 0xFF), 0);
  });

  it("maps white / lightest (#E0F8CF) to shade 0", () => {
    assert.equal(gbShadeFromPaletteEntry(0xE0, 0xF8, 0xCF), 0);
  });

  it("maps pure white (255,255,255) to shade 0", () => {
    assert.equal(gbShadeFromPaletteEntry(255, 255, 255), 0);
  });

  it("maps light gray (#87C06A) to shade 1", () => {
    assert.equal(gbShadeFromPaletteEntry(0x87, 0xC0, 0x6A), 1);
  });

  it("maps dark gray (#2E6850) to shade 2", () => {
    assert.equal(gbShadeFromPaletteEntry(0x2E, 0x68, 0x50), 2);
  });

  it("maps black (#071821) to shade 3", () => {
    assert.equal(gbShadeFromPaletteEntry(0x07, 0x18, 0x21), 3);
  });

  it("maps pure black (0,0,0) to shade 3", () => {
    assert.equal(gbShadeFromPaletteEntry(0, 0, 0), 3);
  });
});

describe("parsePng", () => {
  it("throws on invalid (non-PNG) data", () => {
    const buf = Buffer.from("not a png file at all");
    assert.throws(() => parsePng(buf), /Not a valid PNG file/);
  });

  it("throws on truncated PNG signature", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4E, 0x47]); // only half the signature
    assert.throws(() => parsePng(buf), /Not a valid PNG file/);
  });
});
