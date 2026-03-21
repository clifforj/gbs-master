/**
 * Build template ROMs with multiple WRAM layout variants.
 *
 * Each variant places _DATA at a different WRAM address to avoid conflicts
 * with GBS drivers that use specific WRAM pages.  The web app picks the
 * variant whose _DATA pages are free for the loaded GBS file.
 *
 * Variants × modes = total templates:
 *   3 WRAM variants × 2 modes (standard + banked) = 6 template ROMs (~192 KB).
 *
 * Usage:
 *   npx tsx scripts/build-templates.ts [--gbdk-home <path>]
 *
 * Requires GBDK-2020 (SDCC toolchain) to be installed.
 * Set GBDK_HOME env var or pass --gbdk-home.
 */

import { execSync } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { generateConfig, generateTrampolines, buildTrackData } from "../src/build/codegen.js";
import { generateFont, generateSoftFont } from "../src/build/font.js";
import { generateIcons } from "../src/build/icons.js";
import { generateCover } from "../src/build/cover.js";
import { ihxToBinary } from "../src/build/ihx.js";
import type { ParsedGbs } from "../src/gbs/types.js";
import type { Track } from "../src/playlist/types.js";
import type { WramLayout } from "../src/build/wram.js";
import type { BankedCodeOptions } from "../src/build/codegen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const ROM_DIR = join(PROJECT_ROOT, "rom");
const ROM_SRC = join(ROM_DIR, "src");
const ASSET_DIR = join(ROM_DIR, "assets");
const OUTPUT_DIR = join(PROJECT_ROOT, "templates");

/**
 * WRAM layout variants.  Each places _DATA at a different address.
 * The web assembler picks the first variant whose data pages don't
 * conflict with the GBS driver's WRAM usage.
 *
 * Chosen based on scanning all input GBS files:
 *   - "low" (0xC100): works for simple drivers (0xC0xx only)
 *   - "mid" (0xC600): works for Pokemon-class drivers (0xC0-0xC4 used)
 *   - "high" (0xD700): works for most remaining drivers
 *   Together these cover all tested GBS files.
 */
interface WramVariant {
  key: string;
  wram: WramLayout;
  /** Pages that must be free for this variant to work. */
  dataPages: number[];
}

const WRAM_VARIANTS: WramVariant[] = [
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

/** Placeholder GBS for generating template config/trampolines. */
function placeholderGbs(): ParsedGbs {
  const header = {
    magic: "GBS" as const,
    version: 1,
    numSongs: 1,
    firstSong: 1,
    loadAddr: 0x4000,
    initAddr: 0x4000,
    playAddr: 0x4000,
    stackPtr: 0xDFFF,
    timerModulo: 0,
    timerControl: 0,
    title: "",
    author: "",
    copyright: "",
  };
  return {
    header,
    raw: Buffer.alloc(0x70),
    gbsRomOffset: 0x4000,
    usesTimerInterrupt: false,
  };
}

const PLACEHOLDER_TRACKS: Track[] = [{ number: 1, title: "" }];

interface ModeConfig {
  mode: string;
  bankedCode: BankedCodeOptions;
  codeAddr: string;
}

const MODES: ModeConfig[] = [
  {
    mode: "standard",
    bankedCode: { enabled: false, codeBankNum: 0 },
    codeAddr: "0x0380",
  },
  {
    mode: "banked",
    bankedCode: { enabled: true, codeBankNum: 2 },
    codeAddr: "0x4000",
  },
];

function getGbdkHome(): string {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--gbdk-home");
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  const env = process.env["GBDK_HOME"];
  if (env) return env;
  console.error(
    "Error: GBDK_HOME not set. Pass --gbdk-home <path> or set the GBDK_HOME env var."
  );
  process.exit(1);
}

function run(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: "inherit" });
}

async function generateAssets(genDir: string): Promise<void> {
  await generateFont(ASSET_DIR, genDir);
  await generateSoftFont(ASSET_DIR, genDir);
  await generateIcons(ASSET_DIR, genDir);
  await generateCover(genDir);
}

async function buildTemplate(
  gbdkHome: string,
  mode: ModeConfig,
  variant: WramVariant,
): Promise<string> {
  const name = `template-${mode.mode}-${variant.key}`;
  const genDir = join(ROM_SRC, "generated");
  const buildDir = join(ROM_DIR, "build", name);
  mkdirSync(buildDir, { recursive: true });
  mkdirSync(genDir, { recursive: true });

  console.log(`\n── Building ${name} ──`);

  // Generate placeholder config.s and trampolines.s.
  const gbs = placeholderGbs();
  await generateConfig(gbs, PLACEHOLDER_TRACKS, genDir, {
    wram: variant.wram,
    resourceBank: 2,
  });
  await generateTrampolines(
    genDir,
    mode.bankedCode,
    gbs.header.initAddr,
    gbs.header.playAddr,
  );

  const sdcc   = join(gbdkHome, "bin", "sdcc.exe");
  const sdasgb = join(gbdkHome, "bin", "sdasgb.exe");
  const sdldgb = join(gbdkHome, "bin", "sdldgb.exe");

  // Assemble .s files.
  console.log("  Assembling...");
  run(`"${sdasgb}" -o "${join(buildDir, "startup.rel")}" "${join(ROM_SRC, "startup.s")}"`, ROM_DIR);
  run(`"${sdasgb}" -o "${join(buildDir, "trampolines.rel")}" "${join(genDir, "trampolines.s")}"`, ROM_DIR);
  run(`"${sdasgb}" -o "${join(buildDir, "config.rel")}" "${join(genDir, "config.s")}"`, ROM_DIR);

  // Compile C files.
  console.log("  Compiling...");
  const bankedFlag = `-DBANKED_CODE=${mode.bankedCode.enabled ? "1" : "0"}`;
  const codeBankFlag = mode.bankedCode.enabled
    ? ` -DCODE_BANK=${mode.bankedCode.codeBankNum}`
    : "";
  const cFiles = ["main", "player", "ui", "input", "track_data"];
  for (const f of cFiles) {
    run(
      `"${sdcc}" -msm83 --nostdlib --no-std-crt0 -I "${ROM_SRC}" ` +
      `${bankedFlag}${codeBankFlag} ` +
      `-c "${join(ROM_SRC, f + ".c")}" -o "${join(buildDir, f + ".rel")}"`,
      ROM_DIR,
    );
  }

  // Link.
  console.log("  Linking...");
  const dataHex = "0x" + variant.wram.dataAddr.toString(16).toUpperCase();
  const initHex = "0x" + variant.wram.initializedAddr.toString(16).toUpperCase();
  const objs = ["startup", "trampolines", "config", "main", "player", "ui", "input", "track_data"]
    .map((n) => `"${join(buildDir, n + ".rel")}"`)
    .join(" ");
  run(
    `"${sdldgb}" -n -m -i ` +
    `-b _CODE=${mode.codeAddr} -b _DATA=${dataHex} -b _INITIALIZED=${initHex} ` +
    `-o "${join(buildDir, "player.ihx")}" ${objs}`,
    ROM_DIR,
  );

  // IHX → binary.
  const ihxBuf = ihxToBinary(join(buildDir, "player.ihx"));
  const outputPath = join(OUTPUT_DIR, `${name}.gb`);
  writeFileSync(outputPath, ihxBuf);
  console.log(`  Output: ${outputPath} (${ihxBuf.length} bytes)`);
  return name;
}

async function main(): Promise<void> {
  const gbdkHome = getGbdkHome();
  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Generate assets once (shared by all templates).
  const genDir = join(ROM_SRC, "generated");
  mkdirSync(genDir, { recursive: true });
  console.log("Generating assets...");
  await generateAssets(genDir);

  // Build all combinations (modes × variants).
  const templateEntries: Record<string, Record<string, unknown>> = {};

  for (const mode of MODES) {
    for (const variant of WRAM_VARIANTS) {
      const name = await buildTemplate(gbdkHome, mode, variant);
      templateEntries[name] = {
        file: `${name}.gb`,
        mode: mode.mode,
        wramVariant: variant.key,
        codeAddr: parseInt(mode.codeAddr, 16),
        bankedCode: mode.bankedCode.enabled,
        codeBankNum: mode.bankedCode.codeBankNum,
        wram: variant.wram,
        dataPages: variant.dataPages,
      };
    }
  }

  // Write manifest.
  const manifest = {
    wramVariants: WRAM_VARIANTS.map(v => ({
      key: v.key,
      wram: v.wram,
      dataPages: v.dataPages,
    })),
    templates: templateEntries,
    patchOffsets: {
      configTable: 0x0280,
      configTableSize: 128,
      trampolineInitCall: { standard: 0x0204, banked: null },
      trampolinePlayCall: { standard: 0x0208, banked: null },
    },
    resourceBank: {
      fontDataOff: 0x0000,
      fontWidthsOff: 0x05F0,
      softFontOff: 0x064F,
      iconTilesOff: 0x0CAF,
      coverTilesOff: 0x0CEF,
      trackDataOff: 0x0D2F,
    },
  };

  const manifestPath = join(OUTPUT_DIR, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\nManifest: ${manifestPath}`);
  console.log(`\nBuilt ${Object.keys(templateEntries).length} templates.`);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
