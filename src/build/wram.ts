/**
 * WRAM analysis — scans GBS binaries for direct WRAM references and finds a
 * safe layout for the player's state, stack, and track-data cache that
 * avoids conflicts with the GBS sound driver.
 *
 * The track-data cache can be split across an arbitrary number of
 * non-contiguous WRAM regions to accommodate GBS files with heavily
 * fragmented free WRAM (e.g. Pokemon Gold, whose largest free run is only
 * 6 pages even though total free WRAM is ample).
 */

export interface CacheRegion {
  /** WRAM base address of this region (page-aligned). */
  addr: number;
  /** Number of 32-byte cache entries that fit in this region. */
  capacity: number;
}

export interface WramLayout {
  dataAddr: number;        // linker -b _DATA=
  initializedAddr: number; // linker -b _INITIALIZED=
  stackAddr: number;       // SP value for player (top of stack, grows down)
  cacheRegions: CacheRegion[];
  /** Sum of capacities across all cache regions. */
  cacheTotalCapacity: number;
}

/* Must match TRACK_CACHE_ENTRY_SIZE / TRACK_CACHE_MAX_TRACKS in track_data.h. */
const CACHE_ENTRY_SIZE    = 32;
export const CACHE_MAX_TRACKS    = 96;
const ENTRIES_PER_PAGE    = 256 / CACHE_ENTRY_SIZE; // 8
const CACHE_MAX_PAGES     = CACHE_MAX_TRACKS / ENTRIES_PER_PAGE; // 12
const PLAYER_REGION_PAGES = 2;  // _DATA + _INITIALIZED + stack

const PLAYER_DATA_TO_INITIALIZED_OFFSET = 0x00D0;
const PLAYER_DATA_TO_STACK_OFFSET       = 0x0200;

/** Default layout — used when the GBS driver leaves 0xC1-0xCE entirely free. */
export const DEFAULT_WRAM_LAYOUT: WramLayout = {
  dataAddr:           0xC100,
  initializedAddr:    0xC100 + PLAYER_DATA_TO_INITIALIZED_OFFSET,
  stackAddr:          0xC100 + PLAYER_DATA_TO_STACK_OFFSET,
  cacheRegions:       [{ addr: 0xC300, capacity: CACHE_MAX_TRACKS }],
  cacheTotalCapacity: CACHE_MAX_TRACKS,
};

/**
 * Scan GBS code for WRAM page references.  Returns the set of 256-byte pages
 * (high byte 0xC0-0xDF) that the GBS driver directly accesses.
 *
 * Only detects absolute memory operations (low false-positive rate):
 *   - FA lo hi  ->  LD A, (nnnn)    -- direct read
 *   - EA lo hi  ->  LD (nnnn), A    -- direct write
 *
 * Register-indirect accesses (LD A,(HL) etc.) cannot be detected statically
 * without full emulation, but direct accesses cover the vast majority of
 * GBS driver WRAM usage patterns.
 */
export function scanGbsWramPages(gbsData: Uint8Array): Set<number> {
  const code = gbsData.subarray(0x70); // skip GBS header
  const used = new Set<number>();

  for (let i = 0; i < code.length - 2; i++) {
    const op = code[i];
    if (op === 0xFA || op === 0xEA) {
      const addr = code[i + 1] | (code[i + 2] << 8);
      if (addr >= 0xC000 && addr <= 0xDFFF) {
        used.add(addr >> 8);
      }
      i += 2; // skip the 2-byte operand
    }
  }

  return used;
}

interface Run { start: number; length: number; }

/** Find all contiguous runs of free pages in 0xC1-0xDE, sorted by length descending. */
function findFreeRuns(usedPages: Set<number>): Run[] {
  const runs: Run[] = [];
  let runStart = 0;
  let runLen = 0;
  for (let p = 0xC1; p <= 0xDE; p++) {
    if (!usedPages.has(p)) {
      if (runLen === 0) runStart = p;
      runLen++;
    } else {
      if (runLen > 0) runs.push({ start: runStart, length: runLen });
      runLen = 0;
    }
  }
  if (runLen > 0) runs.push({ start: runStart, length: runLen });
  runs.sort((a, b) => b.length - a.length);
  return runs;
}

/**
 * Find a safe WRAM layout.  Carves a 2-page player slot out of the smallest
 * run that can host it (preserving big runs for cache), then fills cache
 * regions from the remaining runs largest-first until demand is met or WRAM
 * is exhausted.
 */
export function findSafeWramLayout(
  usedPages: Set<number>,
  stackPtr: number,
  numTracks: number = CACHE_MAX_TRACKS,
): WramLayout {
  usedPages.add(stackPtr >> 8);

  const clampedTracks = Math.min(numTracks, CACHE_MAX_TRACKS);
  const neededPages = Math.min(
    CACHE_MAX_PAGES,
    Math.ceil(clampedTracks / ENTRIES_PER_PAGE),
  );

  // Fast path: default layout if its pages are all free.
  const defaultPages = Array.from({ length: PLAYER_REGION_PAGES + neededPages },
                                   (_, i) => 0xC1 + i);
  if (defaultPages.every(p => !usedPages.has(p))) return DEFAULT_WRAM_LAYOUT;

  const runs = findFreeRuns(usedPages);

  // Reserve player slot from the smallest viable run so big runs stay free
  // for the cache.  Take from the end so any leftover stays contiguous with
  // whatever else is in that run.
  const playerRunIdx = runs
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.length >= PLAYER_REGION_PAGES)
    .sort((a, b) => a.r.length - b.r.length)[0]?.i;
  if (playerRunIdx === undefined) return DEFAULT_WRAM_LAYOUT;

  const playerHost = runs[playerRunIdx];
  const playerStart = playerHost.start + playerHost.length - PLAYER_REGION_PAGES;
  const dataAddr = playerStart << 8;
  const leftoverLen = playerHost.length - PLAYER_REGION_PAGES;
  if (leftoverLen > 0) {
    runs[playerRunIdx] = { start: playerHost.start, length: leftoverLen };
  } else {
    runs.splice(playerRunIdx, 1);
  }
  runs.sort((a, b) => b.length - a.length);

  const { cacheRegions, cacheTotalCapacity } = fillCacheRegions(runs, neededPages);
  if (cacheRegions.length === 0) return DEFAULT_WRAM_LAYOUT;

  if (cacheTotalCapacity < clampedTracks) {
    console.warn(
      `      WARNING: Track cache only fits ${cacheTotalCapacity} of ${clampedTracks} tracks ` +
      "in free WRAM. The extra tracks will be omitted from the list " +
      "(other tracks will play normally)."
    );
  }

  return {
    dataAddr,
    initializedAddr:    dataAddr + PLAYER_DATA_TO_INITIALIZED_OFFSET,
    stackAddr:          dataAddr + PLAYER_DATA_TO_STACK_OFFSET,
    cacheRegions,
    cacheTotalCapacity,
  };
}

function fillCacheRegions(
  runs: Run[],
  neededPages: number,
): { cacheRegions: CacheRegion[]; cacheTotalCapacity: number } {
  runs = [...runs].sort((a, b) => b.length - a.length);
  const cacheRegions: CacheRegion[] = [];
  let remaining = neededPages;
  for (const run of runs) {
    if (remaining === 0) break;
    const take = Math.min(remaining, run.length);
    cacheRegions.push({ addr: run.start << 8, capacity: take * ENTRIES_PER_PAGE });
    remaining -= take;
  }
  const cacheTotalCapacity = cacheRegions.reduce((n, r) => n + r.capacity, 0);
  return { cacheRegions, cacheTotalCapacity };
}

/**
 * Find cache regions given an already-fixed player placement.  The web
 * assembler uses this: the template ROM has baked-in _DATA/_INITIALIZED
 * addresses, so only the cache table (patched at runtime) is free to vary.
 *
 * `reservedPages` must contain every page consumed by the player block,
 * the GBS driver, and the GBS stack.  Returns an empty list if no suitable
 * free pages remain.
 */
export function findCacheRegions(
  reservedPages: Set<number>,
  numTracks: number,
): { cacheRegions: CacheRegion[]; cacheTotalCapacity: number } {
  const clampedTracks = Math.min(numTracks, CACHE_MAX_TRACKS);
  const neededPages = Math.min(
    CACHE_MAX_PAGES,
    Math.ceil(clampedTracks / ENTRIES_PER_PAGE),
  );
  const runs = findFreeRuns(reservedPages);
  return fillCacheRegions(runs, neededPages);
}
