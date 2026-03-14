import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { headerChecksum, globalChecksum } from "./checksum.js";

describe("headerChecksum", () => {
  it("computes correct checksum for known header bytes", () => {
    // Header checksum covers bytes 0x134-0x14C (25 bytes).
    // Formula: x = x - rom[i] - 1 for each byte.
    const rom = Buffer.alloc(0x150, 0);

    // Put some known values in the header range
    rom[0x134] = 0x01;
    rom[0x135] = 0x02;
    rom[0x136] = 0x03;

    // Manual calculation: start with 0
    // i=0x134: 0 - 1 - 1 = -2 & 0xFF = 0xFE
    // i=0x135: 0xFE - 2 - 1 = 0xFB
    // i=0x136: 0xFB - 3 - 1 = 0xF7
    // i=0x137..0x14C: all zeros, so each step is sum - 0 - 1 = sum - 1
    // That's 0x14C - 0x137 + 1 = 22 more subtractions of 1
    // 0xF7 - 22 = 0xF7 - 0x16 = 0xE1
    const expected = 0xE1;
    assert.equal(headerChecksum(rom), expected);
  });

  it("returns known value for all-zero header range", () => {
    const rom = Buffer.alloc(0x150, 0);
    // 25 bytes (0x134 to 0x14C inclusive), each step: sum = sum - 0 - 1
    // After 25 iterations: sum = -25 & 0xFF = 256 - 25 = 231 = 0xE7
    assert.equal(headerChecksum(rom), 0xE7);
  });

  it("works with Uint8Array", () => {
    const rom = new Uint8Array(0x150);
    assert.equal(headerChecksum(rom), 0xE7);
  });
});

describe("globalChecksum", () => {
  it("sums all bytes except 0x14E-0x14F", () => {
    const rom = Buffer.alloc(16, 0);
    rom[0] = 1;
    rom[1] = 2;
    rom[2] = 3;
    // Total = 6 (bytes 0x14E and 0x14F are beyond this 16-byte buffer)
    assert.equal(globalChecksum(rom), 6);
  });

  it("excludes bytes at 0x14E and 0x14F", () => {
    const rom = Buffer.alloc(0x150, 0);
    rom[0x14E] = 0xFF;
    rom[0x14F] = 0xFF;
    // All other bytes are 0, so sum should be 0
    assert.equal(globalChecksum(rom), 0);
  });

  it("returns 0 for all-zero buffer", () => {
    const rom = Buffer.alloc(256, 0);
    assert.equal(globalChecksum(rom), 0);
  });

  it("handles 16-bit wrapping correctly", () => {
    // Create a buffer where the sum would exceed 16 bits
    const rom = Buffer.alloc(0x200, 0xFF);
    // Clear the checksum bytes so they don't contribute
    rom[0x14E] = 0;
    rom[0x14F] = 0;
    // 0x200 = 512 bytes, minus 2 excluded = 510 bytes of 0xFF
    // sum = 510 * 255 = 130050 & 0xFFFF = 130050 - 65536*1 = 64514 = 0xFC02
    const expected = (510 * 255) & 0xFFFF;
    assert.equal(globalChecksum(rom), expected);
  });
});
