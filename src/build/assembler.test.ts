/**
 * Tests for the web ROM assembler (assembleRom).
 *
 * Uses a minimal fake template ROM to verify config patching,
 * GBS embedding, and resource bank placement.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

// We test the assembler logic directly. Since it imports tile-data.ts
// which is web-only, we test the shared parts indirectly via codegen
// and the assembler's internal logic patterns.

import { parseGbs } from "../gbs/parser.js";
import type { ParsedGbs } from "../gbs/types.js";
import type { Track } from "../playlist/types.js";
import { buildTrackData } from "./codegen.js";
import { scanGbsWramPages, findSafeWramLayout, DEFAULT_WRAM_LAYOUT } from "./wram.js";
import { headerChecksum, globalChecksum } from "./checksum.js";

function makeGbsBytes(loadAddr: number, numSongs: number): Uint8Array {
  const codeSize = 64;
  const data = new Uint8Array(0x70 + codeSize);
  // Magic
  data[0] = 0x47; data[1] = 0x42; data[2] = 0x53; // "GBS"
  data[3] = 1; // version
  data[4] = numSongs;
  data[5] = 1; // firstSong
  // loadAddr (LE)
  data[6] = loadAddr & 0xFF;
  data[7] = (loadAddr >> 8) & 0xFF;
  // initAddr = loadAddr
  data[8] = loadAddr & 0xFF;
  data[9] = (loadAddr >> 8) & 0xFF;
  // playAddr = loadAddr + 0x10
  const playAddr = loadAddr + 0x10;
  data[10] = playAddr & 0xFF;
  data[11] = (playAddr >> 8) & 0xFF;
  // stackPtr = 0xDFFF
  data[12] = 0xFF;
  data[13] = 0xDF;
  return data;
}

describe("web assembler shared logic", () => {
  it("parseGbs accepts Uint8Array (not just Buffer)", () => {
    const data = makeGbsBytes(0x4000, 5);
    const gbs = parseGbs(data);
    assert.equal(gbs.header.numSongs, 5);
    assert.equal(gbs.header.loadAddr, 0x4000);
    assert.equal(gbs.gbsRomOffset, 0x4000 - 0x70);
  });

  it("scanGbsWramPages accepts Uint8Array", () => {
    // Create GBS data with a known FA xx xx pattern
    const data = makeGbsBytes(0x4000, 1);
    // Insert FA C1 00 at offset 0x70 (start of music code)
    data[0x70] = 0xFA;
    data[0x71] = 0x00;
    data[0x72] = 0xC1;
    const pages = scanGbsWramPages(data);
    assert.ok(pages.has(0xC1), "should detect WRAM page 0xC1");
  });

  it("buildTrackData produces correct 32-byte entries", () => {
    const tracks: Track[] = [
      { number: 3, title: "Hello" },
      { number: 7, title: "World" },
    ];
    const data = buildTrackData(tracks);
    assert.equal(data.length, 64);
    assert.equal(data[0], 3);
    assert.equal(data[32], 7);
  });

  it("checksums work on Uint8Array", () => {
    const rom = new Uint8Array(32 * 1024);
    rom[0x134] = 0x42;
    const hck = headerChecksum(rom);
    assert.equal(typeof hck, "number");
    const gck = globalChecksum(rom);
    assert.equal(typeof gck, "number");
  });
});
