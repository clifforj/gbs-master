/**
 * GB ROM checksum functions — pure utility functions for computing
 * the header and global checksums required by the Game Boy ROM format.
 */

/** GB header checksum: x = x - rom[i] - 1 for each byte in 0x134-0x14C. */
export function headerChecksum(rom: Buffer | Uint8Array): number {
  let sum = 0;
  for (let i = 0x134; i <= 0x14c; i++) {
    sum = (sum - rom[i] - 1) & 0xff;
  }
  return sum;
}

/** GB global checksum: 16-bit sum of all bytes except 0x14E-0x14F. */
export function globalChecksum(rom: Buffer | Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < rom.length; i++) {
    if (i !== 0x14e && i !== 0x14f) sum = (sum + rom[i]) & 0xffff;
  }
  return sum;
}
