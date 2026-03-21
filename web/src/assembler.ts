/**
 * ROM Assembler — patches a pre-compiled template ROM with GBS-specific data.
 *
 * This is the browser-side equivalent of the Node.js build pipeline.
 * Instead of compiling C code with SDCC, it takes a pre-compiled template ROM
 * and patches in the config table, trampoline call targets, GBS data,
 * and resource bank (assets + track data).
 *
 * Multiple template variants exist with different WRAM _DATA placements.
 * The assembler picks the variant whose _DATA pages don't conflict with
 * the GBS driver's WRAM usage.
 */

import type { ParsedGbs } from "../../src/gbs/types.js";
import { scanGbsWramPages } from "../../src/build/wram.js";
import type { WramLayout } from "../../src/build/wram.js";
import { headerChecksum, globalChecksum } from "../../src/build/checksum.js";
import { buildTrackData } from "../../src/build/track-data.js";
import type { Track } from "../../src/playlist/types.js";
import {
  FONT_TILE_DATA,
  FONT_WIDTH_DATA,
  SOFT_FONT_TILE_DATA,
  ICON_TILE_DATA,
  DEFAULT_COVER_TILES,
} from "./assets/tile-data.js";

// ── Constants ────────────────────────────────────────────────────────────────

const BANK_SIZE = 0x4000;

/**
 * WRAM layout variants — must match scripts/build-templates.ts.
 * Each variant places _DATA at a different address to avoid conflicts
 * with GBS drivers.  Variable addresses are baked into compiled machine code
 * and cannot be relocated at runtime.  Only the stack pointer is patchable.
 */
export interface WramVariant {
  key: string;
  wram: WramLayout;
  /** WRAM pages that must be free for this variant's _DATA to be safe. */
  dataPages: number[];
}

export const WRAM_VARIANTS: WramVariant[] = [
  {
    key: "low",
    wram: { dataAddr: 0xC100, initializedAddr: 0xC1C0, stackAddr: 0xC300 },
    dataPages: [0xC1, 0xC2],
  },
  {
    key: "mid",
    wram: { dataAddr: 0xC600, initializedAddr: 0xC6C0, stackAddr: 0xC800 },
    dataPages: [0xC6, 0xC7],
  },
  {
    key: "high",
    wram: { dataAddr: 0xD700, initializedAddr: 0xD7C0, stackAddr: 0xD900 },
    dataPages: [0xD7, 0xD8],
  },
];

/** Config table layout at ROM 0x0280 (128 bytes total). */
const CONFIG_BASE = 0x0280;

/** Config table field offsets (within the 128-byte table). */
const CFG_INIT_ADDR    = 0x00; // 2 bytes LE
const CFG_PLAY_ADDR    = 0x02; // 2 bytes LE
const CFG_STACK_PTR    = 0x04; // 2 bytes LE
const CFG_TIMER_MOD    = 0x06; // 1 byte
const CFG_TIMER_CTL    = 0x07; // 1 byte
const CFG_USE_TIMER    = 0x08; // 1 byte
const CFG_NUM_TRACKS   = 0x09; // 1 byte
const CFG_RES_BANK     = 0x0A; // 1 byte
const CFG_PLAYER_STACK = 0x0B; // 2 bytes LE
const CFG_ALBUM_TITLE  = 0x0D; // 31 bytes null-terminated
const CFG_ALBUM_AUTHOR = 0x2C; // 31 bytes null-terminated
const CFG_ALBUM_COPY   = 0x4B; // 31 bytes null-terminated

/**
 * Trampoline patch offsets within bank 0.
 * Non-banked mode: CALL targets are at fixed ROM offsets.
 * Banked mode: CALL targets are embedded in a longer trampoline sequence.
 */
const TRAMPOLINE = {
  /** Non-banked init CALL target (2 bytes LE at this ROM offset). */
  standardInitCall: 0x0204,
  /** Non-banked play CALL target (2 bytes LE at this ROM offset). */
  standardPlayCall: 0x0208,
  /**
   * Banked init CALL target (2 bytes LE after the CD opcode).
   * push af(1) + ld a,#1(2) + ld (0x2000),a(3) + pop af(1) + CD(1) = 0x020B+8 = 0x0213
   */
  bankedInitCall: 0x0213,
  /** Banked play CALL target (2 bytes LE after the CD opcode). */
  bankedPlayCall: 0x0221,
};

/** Standard GB ROM sizes [headerCode, sizeInBytes]. */
const ROM_SIZE_TABLE: [number, number][] = [
  [0x00,   32 * 1024],
  [0x01,   64 * 1024],
  [0x02,  128 * 1024],
  [0x03,  256 * 1024],
  [0x04,  512 * 1024],
  [0x05, 1024 * 1024],
  [0x06, 2048 * 1024],
  [0x07, 4096 * 1024],
  [0x08, 8192 * 1024],
];

// ── Resource bank layout (fixed offsets within 0x4000-0x7FFF window) ─────────

const RES_FONT_DATA_OFF   = 0x0000; // 1520 bytes
const RES_FONT_WIDTHS_OFF = 0x05F0; //   95 bytes
const RES_SOFT_FONT_OFF   = 0x064F; // 1632 bytes
const RES_ICON_TILES_OFF  = 0x0CAF; //   64 bytes
const RES_COVER_TILES_OFF = 0x0CEF; //   64 bytes
const RES_TRACK_DATA_OFF  = 0x0D2F; //   32 × numTracks bytes

// ── Public API ───────────────────────────────────────────────────────────────

export interface AssembleOptions {
  /** Parsed GBS file. */
  gbs: ParsedGbs;
  /** Track list with 1-based track numbers and titles. */
  tracks: Track[];
  /** Album title override (defaults to GBS header title). */
  albumTitle?: string;
  /** Custom cover tiles (64 bytes, 4 tiles in 2bpp). Uses default if omitted. */
  coverTiles?: Uint8Array;
  /** Pre-compiled template ROM (standard or banked). */
  templateRom: Uint8Array;
  /** True if this is the banked template. */
  bankedMode: boolean;
  /** Code bank number (only relevant in banked mode). */
  codeBankNum?: number;
  /** WRAM variant used for this template. */
  wramVariant: WramVariant;
}

export interface AssembleResult {
  /** Final ROM as Uint8Array, ready for download or emulation. */
  rom: Uint8Array;
  /** WRAM layout used (may differ from default if conflicts detected). */
  wram: WramLayout;
  /** Whether WRAM conflicts were detected (no variant fully avoids them). */
  wramConflicts: boolean;
  /** Resource bank number. */
  resourceBank: number;
}

/**
 * Determine whether a GBS file needs banked mode.
 * Returns true when GBS data overlaps the bank 0 code area (gbsRomOffset < 0x2000).
 */
export function needsBankedMode(gbs: ParsedGbs): boolean {
  return gbs.gbsRomOffset < 0x2000;
}

/**
 * Pick the best WRAM variant for a given GBS file.
 * Returns the first variant whose _DATA pages don't conflict with the GBS driver.
 * Returns null if no variant is conflict-free.
 */
export function pickWramVariant(gbs: ParsedGbs): WramVariant | null {
  const usedPages = scanGbsWramPages(gbs.raw);
  usedPages.add(gbs.header.stackPtr >> 8);

  for (const variant of WRAM_VARIANTS) {
    if (variant.dataPages.every(p => !usedPages.has(p))) {
      return variant;
    }
  }
  return null;
}

/**
 * Assemble a complete Game Boy ROM from a template + GBS data.
 */
export function assembleRom(options: AssembleOptions): AssembleResult {
  const { gbs, tracks, templateRom, bankedMode, wramVariant } = options;
  const { header, raw: gbsBytes, gbsRomOffset } = gbs;

  // 1. Analyze WRAM — check if chosen variant's data pages are safe.
  const usedPages = scanGbsWramPages(gbsBytes);
  usedPages.add(header.stackPtr >> 8);
  const wramConflicts = wramVariant.dataPages.some(p => usedPages.has(p));

  // Stack: use variant default unless the GBS driver conflicts with that page.
  let playerStackAddr = wramVariant.wram.stackAddr;
  const stackPage = playerStackAddr >> 8;
  if (usedPages.has(stackPage)) {
    for (let p = stackPage + 1; p <= 0xDE; p++) {
      if (!usedPages.has(p)) {
        playerStackAddr = (p + 1) << 8;
        break;
      }
    }
  }
  const wram: WramLayout = { ...wramVariant.wram, stackAddr: playerStackAddr };

  // 2. Determine code bank (banked mode only)
  let codeBankNum = options.codeBankNum ?? 0;
  if (bankedMode && !options.codeBankNum) {
    const gbsEnd = gbsRomOffset + gbsBytes.length;
    const lastGbsBank = Math.floor(Math.max(gbsEnd - 1, 0) / BANK_SIZE);
    codeBankNum = lastGbsBank + 1;
  }

  // 3. Build track data blob
  const trackData = buildTrackData(tracks);

  // 4. Calculate resource bank
  const gbsEnd = gbsRomOffset + gbsBytes.length;
  const lastGbsBank = Math.floor(Math.max(gbsEnd - 1, 0) / BANK_SIZE);
  const extraBanks = bankedMode ? 1 : 0;
  const resourceBank = lastGbsBank + 1 + extraBanks;
  const resourceRomOffset = resourceBank * BANK_SIZE;

  // 5. Build resource blob
  const resourceBlob = buildResourceBlob(
    options.coverTiles ?? DEFAULT_COVER_TILES,
    trackData,
  );

  // 6. Allocate ROM
  const gbsRequired = gbsRomOffset + gbsBytes.length;
  const resRequired = resourceRomOffset + resourceBlob.length;
  const codeRequired = bankedMode ? codeBankNum * BANK_SIZE + BANK_SIZE : 0;
  const requiredSize = Math.max(gbsRequired, resRequired, codeRequired);
  const [romSizeCode, romSizeBytes] = pickRomSize(requiredSize);

  if (romSizeBytes === 0) {
    throw new Error(`GBS file too large for any standard GB ROM size (needs ${requiredSize} bytes).`);
  }

  const rom = new Uint8Array(romSizeBytes);
  rom.fill(0xFF);

  // 7. Copy template code — bank 0
  const bank0End = Math.min(BANK_SIZE, templateRom.length);
  rom.set(templateRom.subarray(0, bank0End), 0);

  // In banked mode, copy _CODE to its dedicated bank
  if (bankedMode) {
    const codeRomOffset = codeBankNum * BANK_SIZE;
    const codeSrcStart = BANK_SIZE;
    const codeSrcEnd = Math.min(BANK_SIZE * 2, templateRom.length);
    if (codeSrcEnd > codeSrcStart) {
      rom.set(templateRom.subarray(codeSrcStart, codeSrcEnd), codeRomOffset);
    }
  }

  // 8. Patch config table
  patchConfigTable(rom, {
    initAddr: header.initAddr,
    playAddr: header.playAddr,
    stackPtr: header.stackPtr,
    timerModulo: header.timerModulo,
    timerControl: header.timerControl,
    useTimer: gbs.usesTimerInterrupt,
    numTracks: tracks.length,
    resourceBank,
    playerStackPtr: wram.stackAddr,
    albumTitle: options.albumTitle ?? header.title,
    albumAuthor: header.author,
    albumCopyright: header.copyright,
  });

  // 9. Patch trampoline call targets
  if (bankedMode) {
    patchTrampolineBanked(rom, header.initAddr, header.playAddr, codeBankNum);
  } else {
    writeU16LE(rom, TRAMPOLINE.standardInitCall, header.initAddr);
    writeU16LE(rom, TRAMPOLINE.standardPlayCall, header.playAddr);
  }

  // 10. Embed GBS data
  rom.set(gbsBytes, gbsRomOffset);

  // 11. Write resource blob
  rom.set(resourceBlob, resourceRomOffset);

  // 12. Patch cartridge header
  patchCartHeader(rom, romSizeCode);

  return { rom, wram, wramConflicts, resourceBank };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function pickRomSize(requiredBytes: number): [number, number] {
  for (const [code, size] of ROM_SIZE_TABLE) {
    if (size >= requiredBytes) return [code, size];
  }
  return [-1, 0];
}

function writeU16LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xFF;
  buf[offset + 1] = (value >> 8) & 0xFF;
}

function writeAsciiField(buf: Uint8Array, offset: number, str: string, maxLen: number): void {
  const ascii = str.replace(/[^\x20-\x7e]/g, "?");
  const len = Math.min(ascii.length, maxLen);
  for (let i = 0; i < len; i++) {
    buf[offset + i] = ascii.charCodeAt(i);
  }
  buf[offset + len] = 0;
}

interface ConfigValues {
  initAddr: number;
  playAddr: number;
  stackPtr: number;
  timerModulo: number;
  timerControl: number;
  useTimer: boolean;
  numTracks: number;
  resourceBank: number;
  playerStackPtr: number;
  albumTitle: string;
  albumAuthor: string;
  albumCopyright: string;
}

function patchConfigTable(rom: Uint8Array, cfg: ConfigValues): void {
  const base = CONFIG_BASE;
  rom.fill(0, base, base + 128);

  writeU16LE(rom, base + CFG_INIT_ADDR, cfg.initAddr);
  writeU16LE(rom, base + CFG_PLAY_ADDR, cfg.playAddr);
  writeU16LE(rom, base + CFG_STACK_PTR, cfg.stackPtr);
  rom[base + CFG_TIMER_MOD] = cfg.timerModulo;
  rom[base + CFG_TIMER_CTL] = cfg.timerControl;
  rom[base + CFG_USE_TIMER] = cfg.useTimer ? 0x01 : 0x00;
  rom[base + CFG_NUM_TRACKS] = cfg.numTracks;
  rom[base + CFG_RES_BANK] = cfg.resourceBank;
  writeU16LE(rom, base + CFG_PLAYER_STACK, cfg.playerStackPtr);
  writeAsciiField(rom, base + CFG_ALBUM_TITLE, cfg.albumTitle, 30);
  writeAsciiField(rom, base + CFG_ALBUM_AUTHOR, cfg.albumAuthor, 30);
  writeAsciiField(rom, base + CFG_ALBUM_COPY, cfg.albumCopyright, 30);
}

function patchTrampolineBanked(
  rom: Uint8Array,
  initAddr: number,
  playAddr: number,
  codeBankNum: number,
): void {
  const TEMPLATE_CODE_BANK = 2;
  const TRAMPOLINE_START = 0x0200;
  const TRAMPOLINE_END = 0x0280;

  for (let i = TRAMPOLINE_START; i < TRAMPOLINE_END - 1; i++) {
    if (rom[i] === 0x3E && rom[i + 1] === TEMPLATE_CODE_BANK) {
      rom[i + 1] = codeBankNum;
    }
  }

  writeU16LE(rom, 0x0213, initAddr);
  writeU16LE(rom, 0x0221, playAddr);
}

function buildResourceBlob(
  coverTiles: Uint8Array,
  trackData: Uint8Array,
): Uint8Array {
  const totalSize = RES_TRACK_DATA_OFF + trackData.length;
  const blob = new Uint8Array(totalSize);

  blob.set(FONT_TILE_DATA, RES_FONT_DATA_OFF);
  blob.set(FONT_WIDTH_DATA, RES_FONT_WIDTHS_OFF);
  blob.set(SOFT_FONT_TILE_DATA, RES_SOFT_FONT_OFF);
  blob.set(ICON_TILE_DATA, RES_ICON_TILES_OFF);
  blob.set(coverTiles, RES_COVER_TILES_OFF);
  blob.set(trackData, RES_TRACK_DATA_OFF);

  return blob;
}

function patchCartHeader(rom: Uint8Array, romSizeCode: number): void {
  rom[0x0147] = 0x01; // cart type: MBC1
  rom[0x0148] = romSizeCode; // ROM size
  rom[0x014D] = headerChecksum(rom);
  const global = globalChecksum(rom);
  rom[0x014E] = (global >> 8) & 0xFF;
  rom[0x014F] = global & 0xFF;
}
