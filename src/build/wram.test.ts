import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { scanGbsWramPages, findSafeWramLayout, DEFAULT_WRAM_LAYOUT } from "./wram.js";

/**
 * Build a minimal GBS buffer: 112-byte header + code bytes.
 */
function makeGbsWithCode(codeBytes: number[]): Buffer {
  const header = Buffer.alloc(0x70, 0);
  header.write("GBS", 0);
  header[3] = 1; // version
  header[4] = 1; // numSongs
  header[5] = 1; // firstSong
  header.writeUInt16LE(0x3F56, 6); // loadAddr
  return Buffer.concat([header, Buffer.from(codeBytes)]);
}

describe("scanGbsWramPages", () => {
  it("detects WRAM page from FA opcode (LD A,(nnnn))", () => {
    // FA lo hi -> LD A, (0xC109) => page 0xC1
    const buf = makeGbsWithCode([0xFA, 0x09, 0xC1]);
    const pages = scanGbsWramPages(buf);
    assert.ok(pages.has(0xC1));
  });

  it("detects WRAM page from EA opcode (LD (nnnn),A)", () => {
    // EA lo hi -> LD (0xC200), A => page 0xC2
    const buf = makeGbsWithCode([0xEA, 0x00, 0xC2]);
    const pages = scanGbsWramPages(buf);
    assert.ok(pages.has(0xC2));
  });

  it("ignores non-WRAM addresses (< 0xC000)", () => {
    // FA lo hi -> LD A, (0x8000) => not WRAM
    const buf = makeGbsWithCode([0xFA, 0x00, 0x80]);
    const pages = scanGbsWramPages(buf);
    assert.equal(pages.size, 0);
  });

  it("ignores addresses > 0xDFFF", () => {
    // FA lo hi -> LD A, (0xFF80) => HRAM, not WRAM
    const buf = makeGbsWithCode([0xFA, 0x80, 0xFF]);
    const pages = scanGbsWramPages(buf);
    assert.equal(pages.size, 0);
  });

  it("detects multiple pages from multiple opcodes", () => {
    const buf = makeGbsWithCode([
      0xFA, 0x09, 0xC1,   // LD A, (0xC109) => page 0xC1
      0xEA, 0x58, 0xC3,   // LD (0xC358), A => page 0xC3
      0xFA, 0x0B, 0xD5,   // LD A, (0xD50B) => page 0xD5
    ]);
    const pages = scanGbsWramPages(buf);
    assert.ok(pages.has(0xC1));
    assert.ok(pages.has(0xC3));
    assert.ok(pages.has(0xD5));
    assert.equal(pages.size, 3);
  });

  it("returns empty set for empty code section (just header)", () => {
    const buf = makeGbsWithCode([]);
    const pages = scanGbsWramPages(buf);
    assert.equal(pages.size, 0);
  });
});

describe("findSafeWramLayout", () => {
  it("returns DEFAULT_WRAM_LAYOUT when no conflicts", () => {
    const used = new Set<number>();
    // stackPtr 0xDFFF => page 0xDF added internally
    const result = findSafeWramLayout(used, 0xDFFF);
    assert.deepEqual(result, DEFAULT_WRAM_LAYOUT);
  });

  it("relocates when page 0xC1 is used", () => {
    const used = new Set<number>([0xC1]);
    const result = findSafeWramLayout(used, 0xDFFF);
    // Should not be default since 0xC1 conflicts
    assert.notDeepEqual(result, DEFAULT_WRAM_LAYOUT);
    // Should find a valid 3-page block
    const basePage = result.dataAddr >> 8;
    assert.ok(basePage >= 0xC1 && basePage <= 0xDE);
    assert.equal(result.stackAddr, result.dataAddr + 0x300);
  });

  it("relocates when pages 0xC1-0xC3 are all used", () => {
    const used = new Set<number>([0xC1, 0xC2, 0xC3]);
    const result = findSafeWramLayout(used, 0xDFFF);
    assert.notDeepEqual(result, DEFAULT_WRAM_LAYOUT);
    // The block should not overlap with 0xC1-0xC3
    const basePage = result.dataAddr >> 8;
    const endPage = basePage + 2;
    for (let p = basePage; p <= endPage; p++) {
      assert.ok(!used.has(p), `layout should not overlap used page 0x${p.toString(16)}`);
    }
  });

  it("returns DEFAULT_WRAM_LAYOUT as fallback when all pages used", () => {
    const used = new Set<number>();
    for (let p = 0xC1; p <= 0xDE; p++) {
      used.add(p);
    }
    // Suppress the warning
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const result = findSafeWramLayout(used, 0xDFFF);
      assert.deepEqual(result, DEFAULT_WRAM_LAYOUT);
    } finally {
      console.warn = origWarn;
    }
  });

  it("marks GBS stack page as used", () => {
    // stackPtr=0xC2FF => page 0xC2. This conflicts with default (0xC1,0xC2,0xC3).
    const used = new Set<number>();
    const result = findSafeWramLayout(used, 0xC2FF);
    // Page 0xC2 is used by GBS stack, so default should fail
    assert.notDeepEqual(result, DEFAULT_WRAM_LAYOUT);
  });
});
