/**
 * ROM builder — orchestrates the full pipeline:
 *
 *  1. Parse the GBS file.
 *  2. Merge with the optional playlist for per-track metadata.
 *  3. Analyse GBS binary for WRAM conflicts and banked-code needs.
 *  4. Generate config table, trampolines, and tile assets.
 *  5. Compile the player ROM with SDCC.
 *  6. Embed GBS data, resource bank, and patch the cartridge header.
 */

import { execSync } from "child_process";
import { readFile, writeFile, mkdir } from "fs/promises";
import { writeFileSync } from "fs";
import { resolve, dirname, join, basename } from "path";
import { fileURLToPath } from "url";
import { parseGbsFile } from "../gbs/parser.js";
import { loadPlaylist, resolveTrackList } from "../playlist/manager.js";
import { generateConfig, generateTrampolines, buildTrackData } from "./codegen.js";
import type { BankedCodeOptions } from "./codegen.js";
import { generateFont, generateSoftFont } from "./font.js";
import { generateIcons } from "./icons.js";
import { generateCover } from "./cover.js";
import { ihxToBinary } from "./ihx.js";
import { scanGbsWramPages, findSafeWramLayout, DEFAULT_WRAM_LAYOUT } from "./wram.js";
import type { WramLayout } from "./wram.js";
import { headerChecksum, globalChecksum } from "./checksum.js";
import type { ParsedGbs } from "../gbs/types.js";
import type { Track } from "../playlist/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Path to the rom/ directory (two levels up from dist/build/)
const ROM_DIR = resolve(__dirname, "../../rom");
const ROM_BUILD_DIR = join(ROM_DIR, "build");
const ROM_GENERATED_DIR = join(ROM_DIR, "src", "generated");
const COMPILED_ROM_PATH = join(ROM_BUILD_DIR, "player.gb");

// ── Standard GB ROM sizes ─────────────────────────────────────────────────────
// Each entry is [romSizeCode, sizeInBytes].
// The code is written to the cartridge header at 0x0148.
const ROM_SIZE_TABLE: [number, number][] = [
  [0x00,   32 * 1024],  // 32 KiB  — no MBC needed
  [0x01,   64 * 1024],  // 64 KiB
  [0x02,  128 * 1024],  // 128 KiB
  [0x03,  256 * 1024],  // 256 KiB
  [0x04,  512 * 1024],  // 512 KiB
  [0x05, 1024 * 1024],  // 1 MiB
  [0x06, 2048 * 1024],  // 2 MiB
  [0x07, 4096 * 1024],  // 4 MiB
  [0x08, 8192 * 1024],  // 8 MiB
];

// GB ROM bank size (16 KiB).
const BANK_SIZE = 0x4000;

// ── Resource bank ─────────────────────────────────────────────────────────────
// Large const data (font tiles, icon tiles, cover tiles, track data) is placed
// in a dedicated ROM bank that does not overlap with the GBS music data.
// At runtime the player bank-switches (MBC1 write to 0x2000) to access it.

interface ResourceLayout {
  bank: number;
  romOffset: number;        // byte offset in ROM file
  blob: Buffer;             // concatenated binary data
  fontDataOff: number;
  fontDataSize: number;
  fontWidthsOff: number;
  fontWidthsSize: number;
  softFontOff: number;
  softFontSize: number;
  iconTilesOff: number;
  iconTilesSize: number;
  coverTilesOff: number;
  coverTilesSize: number;
  trackDataOff: number;
  trackDataSize: number;
}

function buildResourceBlob(
  fontTileData: Uint8Array,
  fontWidthData: Uint8Array,
  softFontTileData: Uint8Array,
  iconTileData: Uint8Array,
  coverTileData: Uint8Array,
  trackData: Uint8Array,
  gbsRomOffset: number,
  gbsSize: number,
  /** Number of extra banks reserved between GBS data and resources (e.g. 1 for code bank). */
  extraBanks: number = 0,
): ResourceLayout {
  // Determine the first free bank after the GBS data (and any extra reserved banks).
  const gbsEnd = gbsRomOffset + gbsSize;
  const lastGbsBank = Math.floor(Math.max(gbsEnd - 1, 0) / BANK_SIZE);
  const bank = lastGbsBank + 1 + extraBanks;
  // MBC1 bank register treats 0 as 1, so resource bank must be >= 1.
  // Since GBS always occupies at least bank 0, bank >= 1 is guaranteed.

  // Build the resource blob — concatenation of all data sections.
  // Layout must match the fixed offsets in rom/src/resource_bank.h.
  let off = 0;
  const fontDataOff = off;       off += fontTileData.length;
  const fontWidthsOff = off;     off += fontWidthData.length;
  const softFontOff = off;       off += softFontTileData.length;
  const iconTilesOff = off;      off += iconTileData.length;
  const coverTilesOff = off;     off += coverTileData.length;
  const trackDataOff = off;      off += trackData.length;

  const blob = Buffer.alloc(off);
  blob.set(fontTileData, fontDataOff);
  blob.set(fontWidthData, fontWidthsOff);
  blob.set(softFontTileData, softFontOff);
  blob.set(iconTileData, iconTilesOff);
  blob.set(coverTileData, coverTilesOff);
  blob.set(trackData, trackDataOff);

  return {
    bank,
    romOffset: bank * BANK_SIZE,
    blob,
    fontDataOff,     fontDataSize: fontTileData.length,
    fontWidthsOff,   fontWidthsSize: fontWidthData.length,
    softFontOff,     softFontSize: softFontTileData.length,
    iconTilesOff,    iconTilesSize: iconTileData.length,
    coverTilesOff,   coverTilesSize: coverTileData.length,
    trackDataOff,    trackDataSize: trackData.length,
  };
}

// ── GBS analysis ──────────────────────────────────────────────────────────────

interface GbsAnalysis {
  wram: WramLayout;
  bankedCode: BankedCodeOptions;
}

/**
 * Analyse a parsed GBS file to determine WRAM layout and banked-code mode.
 * Scans the GBS binary for direct WRAM references to find safe addresses
 * for the player's variables and stack, and checks whether the GBS data
 * would overlap the player's _CODE section in bank 0.
 */
function analyzeGbs(gbs: ParsedGbs, numTracks: number): GbsAnalysis {
  const usedPages = scanGbsWramPages(gbs.raw);
  const wram = findSafeWramLayout(usedPages, gbs.header.stackPtr, numTracks);

  // If the GBS data starts below 0x2000 in the ROM, _CODE (at 0x0380,
  // ~2.5-3 KB) would be overwritten by the GBS data. Place _CODE in a
  // dedicated ROM bank instead.
  const bankedCode: BankedCodeOptions = {
    enabled: gbs.gbsRomOffset < 0x2000,
    codeBankNum: 0,
  };
  if (bankedCode.enabled) {
    const gbsEnd = gbs.gbsRomOffset + gbs.raw.length;
    const lastGbsBank = Math.floor(Math.max(gbsEnd - 1, 0) / BANK_SIZE);
    bankedCode.codeBankNum = lastGbsBank + 1;
  }

  return { wram, bankedCode };
}

// ── Asset generation ──────────────────────────────────────────────────────────

interface AssetResults {
  fontTileData: Uint8Array;
  fontWidthData: Uint8Array;
  softFontTileData: Uint8Array;
  iconTileData: Uint8Array;
  coverTileData: Uint8Array;
}

/**
 * Generate all tile assets (fonts, icons, cover) from PNGs.
 * Returns the raw tile data for each asset, ready for the resource bank.
 */
async function generateAssets(coverPath?: string): Promise<AssetResults> {
  const assetDir = join(ROM_DIR, "assets");
  const fontResult = await generateFont(assetDir, ROM_GENERATED_DIR);
  const softFontResult = await generateSoftFont(assetDir, ROM_GENERATED_DIR);
  const iconResult = await generateIcons(assetDir, ROM_GENERATED_DIR);
  const coverResult = await generateCover(ROM_GENERATED_DIR, coverPath);

  return {
    fontTileData: fontResult.tileData,
    fontWidthData: fontResult.widthData,
    softFontTileData: softFontResult.tileData,
    iconTileData: iconResult.tileData,
    coverTileData: coverResult.tileData,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface BuildOptions {
  gbsPath: string;
  outputPath: string;
  playlistPath?: string;
  /** Path to a 16x16 PNG to use as the album cover. Uses a default disc if omitted. */
  coverPath?: string;
  /** Path to GBDK installation root. Defaults to env var GBDK_HOME. */
  gbdkHome?: string;
}

export async function build(options: BuildOptions): Promise<void> {
  const { gbsPath, outputPath, playlistPath } = options;
  const gbdkHome = options.gbdkHome ?? process.env["GBDK_HOME"];

  if (!gbdkHome) {
    throw new Error(
      "GBDK_HOME is not set. " +
        "Install GBDK-2020 and set the GBDK_HOME environment variable to its root directory, " +
        "or pass --gbdk-home on the command line."
    );
  }

  // ── Step 1: Parse GBS file ────────────────────────────────────────────────
  console.log(`[1/6] Parsing GBS file: ${gbsPath}`);
  const gbs = await parseGbsFile(gbsPath);
  const { header } = gbs;
  console.log(
    `      "${header.title}" by ${header.author} — ${header.numSongs} tracks`
  );

  // ── Step 2: Resolve track list ────────────────────────────────────────────
  console.log("[2/6] Resolving track list...");
  const playlist = playlistPath ? await loadPlaylist(playlistPath) : undefined;
  const rawTracks = resolveTrackList(gbs, playlist);
  const namedTracks = rawTracks.filter((t) => !t.title.startsWith("Track ")).length;
  console.log(
    `      ${rawTracks.length} tracks` +
      (namedTracks > 0 ? `, ${namedTracks} with custom titles` : " (no playlist — using placeholders)")
  );

  // ── Step 3: Analyse GBS and generate code + assets ────────────────────────
  const { wram, bankedCode } = analyzeGbs(gbs, rawTracks.length);

  // Drop any tracks that can't fit in the WRAM cache — the ROM only renders
  // (and can only play) what the cache holds.  The allocator already warned.
  const tracks = rawTracks.length > wram.cacheTotalCapacity
    ? rawTracks.slice(0, wram.cacheTotalCapacity)
    : rawTracks;

  if (wram !== DEFAULT_WRAM_LAYOUT) {
    const hex = (n: number) => n.toString(16).toUpperCase();
    const cacheStr = wram.cacheRegions.length === 1
      ? `CACHE=0x${hex(wram.cacheRegions[0].addr)}`
      : `CACHE=${wram.cacheRegions.map(r => `0x${hex(r.addr)}(${r.capacity})`).join("+")}`;
    console.log(
      `      WRAM layout: DATA=0x${hex(wram.dataAddr)}, ` +
      `STACK=0x${hex(wram.stackAddr)}, ${cacheStr} ` +
      `(GBS uses pages that conflict with default)`
    );
  }
  if (bankedCode.enabled) {
    console.log(
      `      Banked code: _CODE will be placed in bank ${bankedCode.codeBankNum} ` +
      `(GBS data overlaps bank 0 code area)`
    );
  }

  console.log("[3/6] Generating config + assets...");
  const assets = await generateAssets(options.coverPath);

  // Build track data blob for the resource bank.
  const trackData = buildTrackData(tracks);

  // Build the resource bank blob BEFORE generating config (need the bank number).
  const res = buildResourceBlob(
    assets.fontTileData,
    assets.fontWidthData,
    assets.softFontTileData,
    assets.iconTileData,
    assets.coverTileData,
    trackData,
    gbs.gbsRomOffset,
    gbs.raw.length,
    bankedCode.enabled ? 1 : 0,
  );
  console.log(`      Resource bank: ${res.bank} (${res.blob.length} bytes of tile + track data)`);

  // Generate config.s with actual GBS values.
  await generateConfig(gbs, tracks, ROM_GENERATED_DIR, {
    title: playlist?.title,
    wram,
    resourceBank: res.bank,
  });

  // Generate trampolines.s (always provides _gbs_init/play_trampoline symbols).
  await generateTrampolines(
    ROM_GENERATED_DIR,
    bankedCode,
    header.initAddr,
    header.playAddr,
  );
  console.log(`      Written to ${ROM_GENERATED_DIR}`);

  // ── Step 4: Compile player ROM ────────────────────────────────────────────
  console.log("[4/6] Compiling player ROM (SDCC)...");
  await mkdir(ROM_BUILD_DIR, { recursive: true });
  compileCRom(gbdkHome, wram, bankedCode);
  console.log(`      Compiled: ${COMPILED_ROM_PATH}`);

  // ── Step 5: Embed GBS data and finalise ROM ───────────────────────────────
  console.log("[5/6] Embedding GBS data and finalising ROM...");
  const finalRom = await embedGbs(gbs, res, bankedCode);
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await writeFile(outputPath, finalRom);
  console.log(`      Written: ${outputPath} (${(finalRom.length / 1024).toFixed(0)} KiB)`);
}

// ── SDCC compilation ─────────────────────────────────────────────────────────

interface BuildStep {
  description: string;
  command: string;
}

function compileCRom(gbdkHome: string, wram: WramLayout, bankedCode: BankedCodeOptions): void {
  const sdcc   = join(gbdkHome, "bin", "sdcc.exe");
  const sdasgb = join(gbdkHome, "bin", "sdasgb.exe");
  const sdldgb = join(gbdkHome, "bin", "sdldgb.exe");

  const bd  = join(ROM_DIR, "build");
  const src = join(ROM_DIR, "src");

  const steps: BuildStep[] = [];

  // 1. Assemble startup.s, trampolines.s, and config.s.
  steps.push({
    description: "Assemble startup.s",
    command: `"${sdasgb}" -o "${join(bd, "startup.rel")}" "${join(src, "startup.s")}"`,
  });
  steps.push({
    description: "Assemble trampolines.s",
    command: `"${sdasgb}" -o "${join(bd, "trampolines.rel")}" "${join(src, "generated", "trampolines.s")}"`,
  });
  steps.push({
    description: "Assemble config.s",
    command: `"${sdasgb}" -o "${join(bd, "config.rel")}" "${join(src, "generated", "config.s")}"`,
  });

  // 2. Compile C files with SDCC.
  //    -msm83:        target the Sharp SM83 CPU (Game Boy CPU)
  //    --nostdlib:     no standard library — avoids RST vector conflicts
  //    --no-std-crt0: no default startup code — we provide our own startup.s
  //    -I src:        include path for header files
  //    -DBANKED_CODE: compile-time flag for banked vs non-banked mode
  const bankedFlag = `-DBANKED_CODE=${bankedCode.enabled ? "1" : "0"}`;
  const codeBankFlag = bankedCode.enabled ? ` -DCODE_BANK=${bankedCode.codeBankNum}` : "";
  const cFiles = ["main", "player", "ui", "input", "track_data"];
  for (const f of cFiles) {
    const outName = basename(f) + ".rel";
    steps.push({
      description: `Compile ${basename(f)}.c`,
      command:
        `"${sdcc}" -msm83 --nostdlib --no-std-crt0 -I "${src}" ` +
        `${bankedFlag}${codeBankFlag} ` +
        `-c "${join(src, f + ".c")}" -o "${join(bd, outName)}"`,
    });
  }

  // 3. Link — -n: no default libs; -m: map file; -i: Intel HEX output
  //    _STARTUP is ABS (positioned by .org), no -b needed.
  //    _CODE:
  //      Non-banked: 0x0380 (after startup code, in bank 0).
  //      Banked:     0x4000 (start of the switchable bank window).
  //    _DATA and _INITIALIZED placed dynamically based on GBS WRAM analysis.
  const codeAddr = bankedCode.enabled ? "0x4000" : "0x0380";
  const dataHex = "0x" + wram.dataAddr.toString(16).toUpperCase();
  const initHex = "0x" + wram.initializedAddr.toString(16).toUpperCase();
  const objs = ["startup", "trampolines", "config", "main", "player", "ui", "input", "track_data"]
    .map((n) => `"${join(bd, n + ".rel")}"`)
    .join(" ");
  steps.push({
    description: "Link player ROM",
    command:
      `"${sdldgb}" -n -m -i ` +
      `-b _CODE=${codeAddr} -b _DATA=${dataHex} -b _INITIALIZED=${initHex} ` +
      `-o "${join(bd, "player.ihx")}" ${objs}`,
  });

  // Execute all build steps.
  for (const step of steps) {
    try {
      execSync(step.command, { cwd: ROM_DIR, stdio: "inherit" });
    } catch {
      throw new Error(`Build step failed (${step.description}): ${step.command}`);
    }
  }

  // 4. IHX → binary using our own parser (makebin mishandles 32-byte records).
  //    ROM-space addresses (0x0000–0x7FFF) are extracted; WRAM records from
  //    _INITIALIZED (0xC110+) are discarded — embedGbs() overwrites that region
  //    with GBS bank data anyway.
  const ihxBuf = ihxToBinary(join(bd, "player.ihx"));
  writeFileSync(join(bd, "player.gb"), ihxBuf);
}

// ── GBS embedding ─────────────────────────────────────────────────────────────

/**
 * Pick the smallest standard GB ROM size that can hold `requiredBytes`.
 * Returns [romSizeCode, sizeInBytes] or [-1, 0] if none fits.
 */
function pickRomSize(requiredBytes: number): [number, number] {
  for (const [code, size] of ROM_SIZE_TABLE) {
    if (size >= requiredBytes) return [code, size];
  }
  return [-1, 0];
}

/**
 * Allocate a ROM buffer of the correct standard size for the given content.
 * Returns the buffer (filled with 0xFF) and the ROM size code for the header.
 */
function allocateRom(
  gbsRomOffset: number,
  gbsSize: number,
  res: ResourceLayout,
  bankedCode: BankedCodeOptions,
): { rom: Buffer; romSizeCode: number } {
  const gbsRequired = gbsRomOffset + gbsSize;
  const resRequired = res.romOffset + res.blob.length;
  const codeRequired = bankedCode.enabled
    ? bankedCode.codeBankNum * BANK_SIZE + BANK_SIZE
    : 0;
  const requiredSize = Math.max(gbsRequired, resRequired, codeRequired);
  const [romSizeCode, romSizeBytes] = pickRomSize(requiredSize);

  if (romSizeBytes === 0) {
    throw new Error(
      `GBS file is too large to fit in any standard GB ROM size ` +
        `(needs ${requiredSize} bytes).`
    );
  }

  return { rom: Buffer.alloc(romSizeBytes, 0xff), romSizeCode };
}

/**
 * Copy compiled player code into the ROM at the correct locations.
 * Bank 0 (startup + trampolines + config) always goes to 0x0000-0x3FFF.
 * In banked mode, _CODE (0x4000-0x7FFF from IHX) goes to the code bank.
 */
function copyCompiledCode(
  rom: Buffer,
  compiledRom: Buffer,
  bankedCode: BankedCodeOptions,
): void {
  // Always copy bank 0 (startup + trampolines + config).
  const bank0End = Math.min(BANK_SIZE, compiledRom.length, rom.length);
  compiledRom.copy(rom, 0, 0, bank0End);

  if (bankedCode.enabled) {
    // Copy _CODE to its dedicated bank.
    const codeRomOffset = bankedCode.codeBankNum * BANK_SIZE;
    const codeSrcStart = BANK_SIZE; // 0x4000 in the compiled ROM
    const codeSrcEnd = Math.min(BANK_SIZE * 2, compiledRom.length);
    if (codeSrcEnd > codeSrcStart) {
      compiledRom.copy(rom, codeRomOffset, codeSrcStart, codeSrcEnd);
    }
  } else {
    // Non-banked: copy full compiled ROM (usually just bank 0 + padding).
    if (compiledRom.length > BANK_SIZE) {
      const extra = Math.min(compiledRom.length, rom.length);
      compiledRom.copy(rom, 0, 0, extra);
    }
  }
}

/**
 * Write cartridge header fields: cart type, ROM size, and checksums.
 */
function patchCartHeader(rom: Buffer, romSizeCode: number): void {
  // Cart type: always MBC1 (resource bank requires bank switching).
  rom[0x147] = 0x01;
  // ROM size code (0x0148).
  rom[0x148] = romSizeCode;
  // Header checksum (0x014D): covers bytes 0x134–0x14C.
  rom[0x14d] = headerChecksum(rom);
  // Global checksum (0x014E–0x014F, big-endian): sum of all bytes except itself.
  const global = globalChecksum(rom);
  rom[0x14e] = (global >> 8) & 0xff;
  rom[0x14f] = global & 0xff;
}

async function embedGbs(
  gbs: ParsedGbs,
  res: ResourceLayout,
  bankedCode: BankedCodeOptions,
): Promise<Buffer> {
  const compiledRom = await readFile(COMPILED_ROM_PATH);
  const { raw: gbsBytes, gbsRomOffset } = gbs;

  const { rom, romSizeCode } = allocateRom(gbsRomOffset, gbsBytes.length, res, bankedCode);

  copyCompiledCode(rom, compiledRom, bankedCode);

  // Embed the full GBS file (header + music code) at the correct offset.
  rom.set(gbsBytes, gbsRomOffset);

  // Embed the resource bank data.
  res.blob.copy(rom, res.romOffset);

  patchCartHeader(rom, romSizeCode);

  return rom;
}
