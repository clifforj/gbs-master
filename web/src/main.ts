/**
 * GBS Master Web App — main entry point.
 *
 * Handles file upload, GBS parsing, playlist editing, and ROM building
 * entirely in the browser using pre-compiled template ROMs.
 */

import { parseGbs } from "../../src/gbs/parse-gbs.js";
import type { ParsedGbs } from "../../src/gbs/types.js";
import type { Track } from "../../src/playlist/types.js";
import {
  assembleRom,
  needsBankedMode,
  pickWramVariant,
  WRAM_VARIANTS,
} from "./assembler.js";
import type { WramVariant } from "./assembler.js";

// ── State ────────────────────────────────────────────────────────────────────

let currentGbs: ParsedGbs | null = null;
let tracks: Track[] = [];
let originalTracks: Track[] = [];
let coverTiles: Uint8Array | undefined;

/** Cache of loaded template ROMs, keyed by filename. */
const templateCache = new Map<string, Uint8Array>();

// ── DOM elements ─────────────────────────────────────────────────────────────

const $dropZone = document.getElementById("drop-zone")!;
const $gbsInput = document.getElementById("gbs-input") as HTMLInputElement;

const $infoSection = document.getElementById("info-section")!;
const $infoTitle = document.getElementById("info-title")!;
const $infoAuthor = document.getElementById("info-author")!;
const $infoTracks = document.getElementById("info-tracks")!;
const $wramWarning = document.getElementById("wram-warning")!;

const $playlistSection = document.getElementById("playlist-section")!;
const $albumTitle = document.getElementById("album-title") as HTMLInputElement;
const $trackList = document.getElementById("track-list")!;

const $coverSection = document.getElementById("cover-section")!;
const $coverInput = document.getElementById("cover-input") as HTMLInputElement;
const $coverStatus = document.getElementById("cover-status")!;

const $buildSection = document.getElementById("build-section")!;
const $buildBtn = document.getElementById("build-btn") as HTMLButtonElement;
const $downloadSection = document.getElementById("download-section")!;
const $downloadLink = document.getElementById("download-link") as HTMLAnchorElement;
const $buildStatus = document.getElementById("build-status")!;

// ── Template loading ─────────────────────────────────────────────────────────

async function loadTemplate(name: string): Promise<Uint8Array> {
  const cached = templateCache.get(name);
  if (cached) return cached;

  const resp = await fetch(`./${name}`);
  if (!resp.ok) throw new Error(`Failed to load template: ${name} (HTTP ${resp.status})`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  if (buf.length < 0x4000) {
    throw new Error(
      `Template ${name} is too small (${buf.length} bytes). ` +
      `Expected a compiled .gb ROM (>= 16384 bytes). ` +
      `Run 'npx tsx scripts/build-templates.ts' to generate templates.`
    );
  }
  templateCache.set(name, buf);
  return buf;
}

/** Build template filename from mode and WRAM variant key. */
function templateFilename(mode: "standard" | "banked", variantKey: string): string {
  return `template-${mode}-${variantKey}.gb`;
}

// ── File handling ────────────────────────────────────────────────────────────

function handleGbsFile(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = new Uint8Array(reader.result as ArrayBuffer);
      currentGbs = parseGbs(data);
      onGbsParsed();
    } catch (err) {
      showError(`Failed to parse GBS file: ${(err as Error).message}`);
    }
  };
  reader.readAsArrayBuffer(file);
}

function onGbsParsed(): void {
  if (!currentGbs) return;
  const { header } = currentGbs;

  // Show info
  $infoTitle.textContent = header.title || "(untitled)";
  $infoAuthor.textContent = header.author || "(unknown)";
  $infoTracks.textContent = String(header.numSongs);
  $infoSection.classList.remove("hidden");

  // Build default track list
  originalTracks = [];
  for (let i = 1; i <= header.numSongs; i++) {
    originalTracks.push({ number: i, title: `Track ${i}` });
  }
  tracks = originalTracks.map((t) => ({ ...t }));
  renderTrackList();

  // Set album title placeholder
  $albumTitle.placeholder = header.title || "Album Title";
  $albumTitle.value = "";

  // Show remaining sections
  $playlistSection.classList.remove("hidden");
  $coverSection.classList.remove("hidden");
  $buildSection.classList.remove("hidden");

  // Reset build state
  $downloadSection.classList.add("hidden");
  $buildStatus.classList.add("hidden");
  $wramWarning.classList.add("hidden");
}

// ── Track list UI ────────────────────────────────────────────────────────────

function renderTrackList(): void {
  $trackList.innerHTML = "";
  for (let i = 0; i < tracks.length; i++) {
    const row = document.createElement("div");
    row.className = "track-row";

    const num = document.createElement("span");
    num.className = "track-num";
    num.textContent = String(i + 1);

    const origLabel = document.createElement("span");
    origLabel.className = "track-orig";
    origLabel.textContent = `#${tracks[i].number}`;

    const input = document.createElement("input");
    input.type = "text";
    input.value = tracks[i].title;
    input.addEventListener("change", () => {
      tracks[i].title = input.value;
    });

    const upBtn = document.createElement("button");
    upBtn.className = "track-btn";
    upBtn.textContent = "\u25B2";
    upBtn.title = "Move up";
    upBtn.disabled = i === 0;
    upBtn.addEventListener("click", () => {
      [tracks[i - 1], tracks[i]] = [tracks[i], tracks[i - 1]];
      renderTrackList();
    });

    const downBtn = document.createElement("button");
    downBtn.className = "track-btn";
    downBtn.textContent = "\u25BC";
    downBtn.title = "Move down";
    downBtn.disabled = i === tracks.length - 1;
    downBtn.addEventListener("click", () => {
      [tracks[i], tracks[i + 1]] = [tracks[i + 1], tracks[i]];
      renderTrackList();
    });

    const removeBtn = document.createElement("button");
    removeBtn.className = "track-btn remove";
    removeBtn.textContent = "\u2715";
    removeBtn.title = "Remove";
    removeBtn.addEventListener("click", () => {
      tracks.splice(i, 1);
      renderTrackList();
    });

    row.appendChild(num);
    row.appendChild(input);
    row.appendChild(origLabel);
    row.appendChild(upBtn);
    row.appendChild(downBtn);
    row.appendChild(removeBtn);
    $trackList.appendChild(row);
  }
}

function resetTracks(): void {
  tracks = originalTracks.map((t) => ({ ...t }));
  renderTrackList();
}

// ── Cover art ────────────────────────────────────────────────────────────────

/** GBStudio Classic palette (plus magenta for transparency). */
const VALID_COLORS: [number, number, number][] = [
  [0xE0, 0xF8, 0xCF],  // white
  [0x87, 0xC0, 0x6A],  // light gray
  [0x2E, 0x68, 0x50],  // dark gray
  [0x07, 0x18, 0x21],  // black
  [0xFF, 0x00, 0xFF],  // transparent
];

function colorMatch(r: number, g: number, b: number): boolean {
  return VALID_COLORS.some(([vr, vg, vb]) =>
    Math.abs(r - vr) <= 2 && Math.abs(g - vg) <= 2 && Math.abs(b - vb) <= 2
  );
}

function handleCoverFile(file: File): void {
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    URL.revokeObjectURL(url);

    const errors: string[] = [];

    if (img.width !== 16 || img.height !== 16) {
      errors.push(`Image must be 16x16, got ${img.width}x${img.height}`);
    }

    // Check palette by sampling all pixels
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;

    const badColors = new Set<string>();
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 128) continue; // transparent pixels are fine
      if (!colorMatch(data[i], data[i + 1], data[i + 2])) {
        badColors.add(`rgb(${data[i]},${data[i + 1]},${data[i + 2]})`);
      }
    }

    if (badColors.size > 0) {
      errors.push(`${badColors.size} color(s) not in expected palette`);
    }

    if (errors.length > 0) {
      $coverStatus.textContent = errors.join(". ");
      $coverStatus.classList.add("cover-error");
      coverTiles = undefined;
    } else {
      $coverStatus.textContent = file.name;
      $coverStatus.classList.remove("cover-error");
      // TODO: Parse PNG → 2bpp tiles using parsePng + shadesToGb2bpp
      coverTiles = undefined; // Will use default until converter is ported
    }
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    $coverStatus.textContent = "Not a valid image file";
    $coverStatus.classList.add("cover-error");
    coverTiles = undefined;
  };
  img.src = url;
}

// ── Build ────────────────────────────────────────────────────────────────────

async function buildRom(): Promise<void> {
  if (!currentGbs) return;

  $buildBtn.disabled = true;
  $buildStatus.textContent = "Building...";
  $buildStatus.className = "build-status";
  $buildStatus.classList.remove("hidden");
  $downloadSection.classList.add("hidden");

  try {
    const banked = needsBankedMode(currentGbs);
    const mode = banked ? "banked" : "standard";

    // Pick the best WRAM variant for this GBS file.
    let wramVariant: WramVariant;
    let forcedConflict = false;
    const picked = pickWramVariant(currentGbs);
    if (picked) {
      wramVariant = picked;
    } else {
      // No variant is fully conflict-free — use the last (highest) as fallback.
      wramVariant = WRAM_VARIANTS[WRAM_VARIANTS.length - 1];
      forcedConflict = true;
    }

    // Load the template for this mode + variant.
    const name = templateFilename(mode, wramVariant.key);
    const template = await loadTemplate(name);

    const albumTitle = $albumTitle.value || undefined;

    const result = assembleRom({
      gbs: currentGbs,
      tracks,
      albumTitle,
      coverTiles,
      templateRom: template,
      bankedMode: banked,
      wramVariant,
    });

    // Show WRAM warning if applicable
    if (result.wramConflicts || forcedConflict) {
      $wramWarning.classList.remove("hidden");
    }

    // Create download link
    const blob = new Blob([result.rom.buffer as ArrayBuffer], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const filename = (currentGbs.header.title || "output").replace(/[^a-zA-Z0-9_-]/g, "_") + ".gb";

    $downloadLink.href = url;
    $downloadLink.download = filename;
    $downloadLink.textContent = `Download ${filename}`;
    $downloadSection.classList.remove("hidden");

    $buildStatus.textContent =
      `ROM built: ${(result.rom.length / 1024).toFixed(0)} KiB, ` +
      `mode: ${mode}, ` +
      `resource bank ${result.resourceBank}, ` +
      `WRAM variant "${wramVariant.key}"`;
    $buildStatus.className = "build-status success";
  } catch (err) {
    showError(`Build failed: ${(err as Error).message}`);
  } finally {
    $buildBtn.disabled = false;
  }
}

function showError(message: string): void {
  $buildStatus.textContent = message;
  $buildStatus.className = "build-status error";
  $buildStatus.classList.remove("hidden");
}

// ── Event listeners ──────────────────────────────────────────────────────────

$dropZone.addEventListener("click", () => $gbsInput.click());

$dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  $dropZone.classList.add("dragover");
});

$dropZone.addEventListener("dragleave", () => {
  $dropZone.classList.remove("dragover");
});

$dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  $dropZone.classList.remove("dragover");
  const file = e.dataTransfer?.files[0];
  if (file) handleGbsFile(file);
});

$gbsInput.addEventListener("change", () => {
  const file = $gbsInput.files?.[0];
  if (file) handleGbsFile(file);
});

$coverInput.addEventListener("change", () => {
  const file = $coverInput.files?.[0];
  if (file) handleCoverFile(file);
});

document.getElementById("reset-tracks-btn")!.addEventListener("click", resetTracks);

$buildBtn.addEventListener("click", buildRom);
