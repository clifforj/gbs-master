import { readFile, writeFile } from "fs/promises";
import type { Playlist, Track } from "./types.js";
import type { ParsedGbs } from "../gbs/types.js";

// ── Disk I/O ──────────────────────────────────────────────────────────────────

export async function loadPlaylist(filePath: string): Promise<Playlist> {
  const raw = await readFile(filePath, "utf8");
  const data = JSON.parse(raw) as Playlist;
  validatePlaylist(data);
  return data;
}

export async function savePlaylist(playlist: Playlist, filePath: string): Promise<void> {
  await writeFile(filePath, JSON.stringify(playlist, null, 2) + "\n", "utf8");
}

// ── Template generation ───────────────────────────────────────────────────────

export function buildTemplateSync(
  gbs: ParsedGbs,
  gbsFilename: string
): Playlist {
  const { header } = gbs;

  const tracks: Track[] = [];
  for (let i = 1; i <= header.numSongs; i++) {
    tracks.push({
      number: i,
      title: `Track ${i}`,
    });
  }

  return { gbs: gbsFilename, tracks };
}

// ── Merging GBS metadata with playlist ───────────────────────────────────────

/**
 * Given a parsed GBS file and an optional playlist, return an array of Track
 * objects to include in the ROM.
 *
 * If a playlist is provided, only the tracks listed in it are included — the
 * ROM will contain exactly those songs and nothing else.
 *
 * With no playlist, all tracks in the GBS file are included with
 * auto-generated placeholder titles ("Track N").
 */
export function resolveTrackList(gbs: ParsedGbs, playlist?: Playlist): Track[] {
  if (playlist) {
    return playlist.tracks;
  }

  const result: Track[] = [];
  for (let i = 1; i <= gbs.header.numSongs; i++) {
    result.push({ number: i, title: `Track ${i}` });
  }
  return result;
}

// ── Validation ────────────────────────────────────────────────────────────────

function validatePlaylist(p: unknown): asserts p is Playlist {
  if (typeof p !== "object" || p === null) throw new Error("Playlist must be a JSON object.");
  const obj = p as Record<string, unknown>;
  if (typeof obj["gbs"] !== "string") throw new Error('Playlist must have a "gbs" string field.');
  if (!Array.isArray(obj["tracks"])) throw new Error('Playlist must have a "tracks" array.');

  const tracks = obj["tracks"] as unknown[];
  const seenNumbers = new Set<number>();

  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (typeof t !== "object" || t === null) {
      throw new Error(`Playlist track ${i}: must be an object.`);
    }
    const track = t as Record<string, unknown>;

    if (typeof track["number"] !== "number" || !Number.isInteger(track["number"]) || (track["number"] as number) < 1) {
      throw new Error(`Playlist track ${i}: "number" must be an integer >= 1.`);
    }
    if (typeof track["title"] !== "string") {
      throw new Error(`Playlist track ${i}: "title" must be a string.`);
    }
    const num = track["number"] as number;
    if (seenNumbers.has(num)) {
      throw new Error(`Playlist track ${i}: duplicate track number ${num}.`);
    }
    seenNumbers.add(num);
  }
}
