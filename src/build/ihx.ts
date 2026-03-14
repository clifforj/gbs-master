/**
 * Intel HEX (.ihx) parser — produces a binary ROM image from IHX records.
 *
 * Custom parser needed because GBDK's `makebin` mishandles SDCC's 32-byte IHX
 * data records — it writes zeros for the second half of each record.
 *
 * Only ROM-space addresses (0x0000-0x7FFF) are extracted. WRAM-addressed records
 * from _INITIALIZED (0xC110+) are discarded since embedGbs() overwrites those
 * regions with GBS bank data.
 */

import { readFileSync } from "fs";

const ROM_END = 0x8000;

/**
 * Parse an Intel HEX (.ihx) file and produce a binary ROM image.
 */
export function ihxToBinary(ihxPath: string): Buffer {
  const content = readFileSync(ihxPath, "ascii");
  return ihxToBinaryFromString(content);
}

/**
 * Parse IHX content from a string (useful for unit testing without disk I/O).
 */
export function ihxToBinaryFromString(ihxContent: string): Buffer {
  const out = Buffer.alloc(ROM_END, 0xff);
  const lines = ihxContent.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith(":")) continue;
    const byteCount = parseInt(line.slice(1, 3), 16);
    const address   = parseInt(line.slice(3, 7), 16);
    const recType   = parseInt(line.slice(7, 9), 16);
    if (recType !== 0x00) continue; // only data records

    // Validate record checksum
    let sum = 0;
    const totalBytes = byteCount + 5; // byte count + addr(2) + type + data + checksum
    for (let i = 0; i < totalBytes; i++) {
      sum += parseInt(line.slice(1 + i * 2, 3 + i * 2), 16);
    }
    if ((sum & 0xff) !== 0) {
      console.warn(`ihxToBinary: bad checksum in record at address 0x${address.toString(16).padStart(4, "0")}`);
    }

    for (let i = 0; i < byteCount; i++) {
      const addr = address + i;
      if (addr < ROM_END) {
        out[addr] = parseInt(line.slice(9 + i * 2, 11 + i * 2), 16);
      }
    }
  }
  return out;
}
