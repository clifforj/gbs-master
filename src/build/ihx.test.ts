import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { ihxToBinaryFromString } from "./ihx.js";

/**
 * Build a valid IHX data record string.
 * Format: :LLAAAATT[DD...]CC
 */
function makeIhxRecord(address: number, data: number[]): string {
  const len = data.length;
  let sum = len + ((address >> 8) & 0xff) + (address & 0xff) + 0x00;
  const hex = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
  let line = `:${hex(len)}${address.toString(16).padStart(4, "0").toUpperCase()}00`;
  for (const b of data) {
    line += hex(b);
    sum += b;
  }
  line += hex((-sum) & 0xff);
  return line;
}

const EOF_RECORD = ":00000001FF";

describe("ihxToBinaryFromString", () => {
  it("parses a single data record and places bytes at correct addresses", () => {
    const record = makeIhxRecord(0x0000, [0x41, 0x42, 0x43]);
    const content = record + "\n" + EOF_RECORD + "\n";
    const result = ihxToBinaryFromString(content);

    assert.equal(result[0], 0x41);
    assert.equal(result[1], 0x42);
    assert.equal(result[2], 0x43);
  });

  it("parses multiple records at different addresses", () => {
    const r1 = makeIhxRecord(0x0000, [0xAA]);
    const r2 = makeIhxRecord(0x0100, [0xBB]);
    const content = r1 + "\n" + r2 + "\n" + EOF_RECORD + "\n";
    const result = ihxToBinaryFromString(content);

    assert.equal(result[0x0000], 0xAA);
    assert.equal(result[0x0100], 0xBB);
  });

  it("discards addresses >= 0x8000 (WRAM)", () => {
    const r1 = makeIhxRecord(0x0000, [0xAA]);
    const r2 = makeIhxRecord(0xC110, [0xBB, 0xCC]); // WRAM, should be discarded
    const content = r1 + "\n" + r2 + "\n" + EOF_RECORD + "\n";
    const result = ihxToBinaryFromString(content);

    assert.equal(result[0x0000], 0xAA);
    // The output buffer is only 0x8000 bytes, so WRAM addresses are not present
    assert.equal(result.length, 0x8000);
  });

  it("handles EOF record without error", () => {
    const content = EOF_RECORD + "\n";
    const result = ihxToBinaryFromString(content);
    assert.equal(result.length, 0x8000);
  });

  it("fills gaps in address space with 0xFF", () => {
    const r1 = makeIhxRecord(0x0000, [0xAA]);
    const r2 = makeIhxRecord(0x0010, [0xBB]);
    const content = r1 + "\n" + r2 + "\n" + EOF_RECORD + "\n";
    const result = ihxToBinaryFromString(content);

    assert.equal(result[0x0000], 0xAA);
    // Bytes 1-15 should be 0xFF (gap)
    for (let i = 1; i < 0x10; i++) {
      assert.equal(result[i], 0xFF, `expected 0xFF at offset ${i}`);
    }
    assert.equal(result[0x0010], 0xBB);
  });

  it("returns all-0xFF buffer for empty file", () => {
    const content = EOF_RECORD + "\n";
    const result = ihxToBinaryFromString(content);
    for (let i = 0; i < result.length; i++) {
      assert.equal(result[i], 0xFF);
    }
  });

  it("warns on bad checksum (does not throw)", () => {
    // Construct a record with an intentionally bad checksum
    const record = ":03000000414243FF"; // checksum FF is wrong
    const content = record + "\n" + EOF_RECORD + "\n";

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      const result = ihxToBinaryFromString(content);
      // Data should still be placed despite bad checksum
      assert.equal(result[0], 0x41);
      assert.equal(result[1], 0x42);
      assert.equal(result[2], 0x43);
      // A warning should have been emitted
      assert.ok(warnings.some(w => w.includes("bad checksum")), "expected a bad checksum warning");
    } finally {
      console.warn = origWarn;
    }
  });

  it("handles 32-byte records correctly (the bug makebin had)", () => {
    // Create a 32-byte record — the exact case that makebin mishandles
    const data = Array.from({ length: 32 }, (_, i) => i);
    const record = makeIhxRecord(0x0100, data);
    const content = record + "\n" + EOF_RECORD + "\n";
    const result = ihxToBinaryFromString(content);

    for (let i = 0; i < 32; i++) {
      assert.equal(result[0x0100 + i], i, `byte at 0x${(0x0100 + i).toString(16)}`);
    }
  });
});
