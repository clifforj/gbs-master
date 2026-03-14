import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { parseGbsBuffer } from "./parser.js";
import { GBS_HEADER_SIZE } from "./types.js";

/**
 * Build a synthetic GBS buffer with sensible defaults.
 * Override any header field via the `overrides` parameter.
 */
function buildSyntheticGbs(overrides?: {
  magic?: string;
  version?: number;
  numSongs?: number;
  firstSong?: number;
  loadAddr?: number;
  initAddr?: number;
  playAddr?: number;
  stackPtr?: number;
  timerModulo?: number;
  timerControl?: number;
  title?: string;
  author?: string;
  copyright?: string;
  extraBytes?: number;
}): Buffer {
  const o = overrides ?? {};
  const buf = Buffer.alloc(GBS_HEADER_SIZE + (o.extraBytes ?? 16), 0);

  // Magic (3 bytes at 0x00)
  buf.write(o.magic ?? "GBS", 0, 3, "ascii");
  // Version (1 byte at 0x03)
  buf[3] = o.version ?? 1;
  // numSongs (1 byte at 0x04)
  buf[4] = o.numSongs ?? 3;
  // firstSong (1 byte at 0x05)
  buf[5] = o.firstSong ?? 1;
  // loadAddr (2 bytes LE at 0x06)
  buf.writeUInt16LE(o.loadAddr ?? 0x3F56, 6);
  // initAddr (2 bytes LE at 0x08)
  buf.writeUInt16LE(o.initAddr ?? 0x3F56, 8);
  // playAddr (2 bytes LE at 0x0A)
  buf.writeUInt16LE(o.playAddr ?? 0x3F7E, 0x0A);
  // stackPtr (2 bytes LE at 0x0C)
  buf.writeUInt16LE(o.stackPtr ?? 0xDFFF, 0x0C);
  // timerModulo (1 byte at 0x0E)
  buf[0x0E] = o.timerModulo ?? 0;
  // timerControl (1 byte at 0x0F)
  buf[0x0F] = o.timerControl ?? 0;
  // title (32 bytes at 0x10)
  buf.write(o.title ?? "Test Game", 0x10, 32, "ascii");
  // author (32 bytes at 0x30)
  buf.write(o.author ?? "Test Author", 0x30, 32, "ascii");
  // copyright (32 bytes at 0x50)
  buf.write(o.copyright ?? "2024", 0x50, 32, "ascii");

  return buf;
}

describe("parseGbsBuffer", () => {
  it("parses a valid GBS buffer and returns correct header fields", () => {
    const buf = buildSyntheticGbs();
    const result = parseGbsBuffer(buf);

    assert.equal(result.header.magic, "GBS");
    assert.equal(result.header.version, 1);
    assert.equal(result.header.numSongs, 3);
    assert.equal(result.header.firstSong, 1);
    assert.equal(result.header.loadAddr, 0x3F56);
    assert.equal(result.header.initAddr, 0x3F56);
    assert.equal(result.header.playAddr, 0x3F7E);
    assert.equal(result.header.stackPtr, 0xDFFF);
    assert.equal(result.header.timerModulo, 0);
    assert.equal(result.header.timerControl, 0);
    assert.equal(result.header.title, "Test Game");
    assert.equal(result.header.author, "Test Author");
    assert.equal(result.header.copyright, "2024");
  });

  it("throws on too-short buffer", () => {
    const buf = Buffer.alloc(0x60, 0); // less than 0x70
    assert.throws(() => parseGbsBuffer(buf), /too short/i);
  });

  it("throws on wrong magic", () => {
    const buf = buildSyntheticGbs({ magic: "XYZ" });
    assert.throws(() => parseGbsBuffer(buf), /Not a GBS file/);
  });

  it("throws on bad version (not 1)", () => {
    const buf = buildSyntheticGbs({ version: 2 });
    assert.throws(() => parseGbsBuffer(buf), /Unsupported GBS version/);
  });

  it("throws on low loadAddr (< 0x0470)", () => {
    const buf = buildSyntheticGbs({ loadAddr: 0x0400, initAddr: 0x0400 });
    assert.throws(() => parseGbsBuffer(buf), /Invalid loadAddr/);
  });

  it("throws on numSongs = 0", () => {
    const buf = buildSyntheticGbs({ numSongs: 0 });
    assert.throws(() => parseGbsBuffer(buf), /no songs/i);
  });

  it("throws when firstSong > numSongs", () => {
    const buf = buildSyntheticGbs({ numSongs: 3, firstSong: 5 });
    assert.throws(() => parseGbsBuffer(buf), /Invalid firstSong/);
  });

  it("throws when initAddr < loadAddr", () => {
    const buf = buildSyntheticGbs({ loadAddr: 0x4000, initAddr: 0x3F00 });
    assert.throws(() => parseGbsBuffer(buf), /Invalid initAddr/);
  });

  it("calculates gbsRomOffset correctly (loadAddr - 0x70)", () => {
    const buf = buildSyntheticGbs({ loadAddr: 0x3F56, initAddr: 0x3F56 });
    const result = parseGbsBuffer(buf);
    assert.equal(result.gbsRomOffset, 0x3F56 - GBS_HEADER_SIZE);
    assert.equal(result.gbsRomOffset, 0x3EE6);
  });

  it("detects timer interrupt flag (bit 6 of timerControl)", () => {
    const withTimer = buildSyntheticGbs({ timerControl: 0x44 }); // bit 6 set
    assert.equal(parseGbsBuffer(withTimer).usesTimerInterrupt, true);

    const withoutTimer = buildSyntheticGbs({ timerControl: 0x04 }); // bit 6 clear
    assert.equal(parseGbsBuffer(withoutTimer).usesTimerInterrupt, false);
  });

  it("parses null-terminated strings correctly (ignores null padding)", () => {
    // Title is "Hi" followed by nulls in a 32-byte field
    const buf = buildSyntheticGbs({ title: "Hi" });
    const result = parseGbsBuffer(buf);
    assert.equal(result.header.title, "Hi");
  });

  it("preserves the raw buffer reference", () => {
    const buf = buildSyntheticGbs();
    const result = parseGbsBuffer(buf);
    assert.equal(result.raw, buf);
  });
});
