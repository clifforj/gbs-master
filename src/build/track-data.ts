/**
 * Track data builder — pure computation, no Node.js dependencies.
 * Safe to import from both Node.js and browser environments.
 */

import type { Track } from "../playlist/types.js";

/**
 * Replace non-printable-ASCII characters with "?".
 * The Game Boy font only covers ASCII 0x20-0x7E.
 */
function toAscii(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, "?");
}

/** Convert a string to ASCII bytes, truncated and null-terminated. */
function stringToAsciiBytes(s: string, maxLen: number): Uint8Array {
  const ascii = toAscii(s);
  const truncated = ascii.length > maxLen ? ascii.slice(0, maxLen) : ascii;
  const bytes = new Uint8Array(maxLen + 1); // +1 for null terminator
  for (let i = 0; i < truncated.length; i++) {
    bytes[i] = truncated.charCodeAt(i);
  }
  return bytes;
}

/**
 * Build the track data blob for the resource bank.
 * Each entry is 32 bytes: [gbs_track:u8][title:char[31]].
 */
export function buildTrackData(tracks: Track[]): Uint8Array {
  const ENTRY_SIZE = 32;
  const TITLE_SIZE = 31;
  const data = new Uint8Array(tracks.length * ENTRY_SIZE);

  for (let i = 0; i < tracks.length; i++) {
    const off = i * ENTRY_SIZE;
    data[off] = tracks[i].number;
    const titleBytes = stringToAsciiBytes(tracks[i].title, TITLE_SIZE - 1);
    data.set(titleBytes, off + 1);
  }

  return data;
}
