/**
 * Pure GBS parser — no Node.js dependencies.
 * Safe to import from both Node.js and browser environments.
 */

import type { GbsHeader, ParsedGbs } from "./types.js";
import { GBS_HEADER_SIZE } from "./types.js";

// ── Byte offsets within the GBS header ──────────────────────────────────────
const OFF_MAGIC = 0x00;         // 3 bytes: "GBS"
const OFF_VERSION = 0x03;       // 1 byte
const OFF_NUM_SONGS = 0x04;     // 1 byte
const OFF_FIRST_SONG = 0x05;    // 1 byte
const OFF_LOAD_ADDR = 0x06;     // 2 bytes, little-endian
const OFF_INIT_ADDR = 0x08;     // 2 bytes, little-endian
const OFF_PLAY_ADDR = 0x0a;     // 2 bytes, little-endian
const OFF_STACK_PTR = 0x0c;     // 2 bytes, little-endian
const OFF_TIMER_MOD = 0x0e;     // 1 byte
const OFF_TIMER_CTL = 0x0f;     // 1 byte
const OFF_TITLE = 0x10;         // 32 bytes, null-padded ASCII
const OFF_AUTHOR = 0x30;        // 32 bytes, null-padded ASCII
const OFF_COPYRIGHT = 0x50;     // 32 bytes, null-padded ASCII

const TIMER_INTERRUPT_BIT = 0x40; // bit 6 of TimerControl

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Read a null-terminated / null-padded ASCII string from a fixed-length field. */
function readString(buf: Uint8Array, offset: number, length: number): string {
  let result = "";
  for (let i = 0; i < length; i++) {
    const ch = buf[offset + i];
    if (ch === 0) break;
    result += String.fromCharCode(ch);
  }
  return result;
}

/** Read a 16-bit little-endian unsigned integer. */
function readU16LE(buf: Uint8Array, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse a GBS file from an in-memory Uint8Array.
 * Browser-compatible — no Node.js APIs needed.
 */
export function parseGbs(raw: Uint8Array): ParsedGbs {
  if (raw.length < GBS_HEADER_SIZE) {
    throw new Error(
      `File is too short to contain a GBS header (got ${raw.length} bytes, need ${GBS_HEADER_SIZE}).`
    );
  }

  const magic = readString(raw, OFF_MAGIC, 3);
  if (magic !== "GBS") {
    throw new Error(`Not a GBS file — expected magic "GBS", got "${magic}".`);
  }

  const version = raw[OFF_VERSION];
  if (version !== 1) {
    throw new Error(`Unsupported GBS version ${version} (only version 1 is supported).`);
  }

  const loadAddr = readU16LE(raw, OFF_LOAD_ADDR);
  if (loadAddr < 0x0470) {
    throw new Error(
      `Invalid loadAddr 0x${loadAddr.toString(16).padStart(4, "0")}: ` +
        `must be >= 0x0470 (the player ROM occupies 0x0000–0x03FF and the ` +
        `GBS header occupies the 0x70 bytes immediately before loadAddr).`
    );
  }

  const header: GbsHeader = {
    magic,
    version,
    numSongs: raw[OFF_NUM_SONGS],
    firstSong: raw[OFF_FIRST_SONG],
    loadAddr,
    initAddr: readU16LE(raw, OFF_INIT_ADDR),
    playAddr: readU16LE(raw, OFF_PLAY_ADDR),
    stackPtr: readU16LE(raw, OFF_STACK_PTR),
    timerModulo: raw[OFF_TIMER_MOD],
    timerControl: raw[OFF_TIMER_CTL],
    title: readString(raw, OFF_TITLE, 32),
    author: readString(raw, OFF_AUTHOR, 32),
    copyright: readString(raw, OFF_COPYRIGHT, 32),
  };

  if (header.numSongs < 1) {
    throw new Error(`GBS file has no songs (numSongs = 0).`);
  }
  if (header.firstSong < 1 || header.firstSong > header.numSongs) {
    throw new Error(
      `Invalid firstSong ${header.firstSong}: must be between 1 and ${header.numSongs}.`
    );
  }
  if (header.initAddr < header.loadAddr) {
    throw new Error(
      `Invalid initAddr 0x${header.initAddr.toString(16).padStart(4, "0")}: ` +
      `must be >= loadAddr 0x${header.loadAddr.toString(16).padStart(4, "0")}.`
    );
  }

  // The GBS file is placed in the ROM at this byte offset so that the music
  // code lands at `loadAddr` in the Game Boy's 16-bit address space.
  const gbsRomOffset = loadAddr - GBS_HEADER_SIZE;

  const usesTimerInterrupt = (header.timerControl & TIMER_INTERRUPT_BIT) !== 0;

  return { header, raw, gbsRomOffset, usesTimerInterrupt };
}
