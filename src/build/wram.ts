/**
 * WRAM analysis — scans GBS binaries for direct WRAM references and finds
 * a safe layout for the player's variables and stack that avoids conflicts
 * with the GBS sound driver.
 */

export interface WramLayout {
  dataAddr: number;        // linker -b _DATA=
  initializedAddr: number; // linker -b _INITIALIZED=
  stackAddr: number;       // SP value for player (top of stack, grows down)
}

/** Default layout — works when GBS doesn't conflict with 0xC100-0xC300. */
export const DEFAULT_WRAM_LAYOUT: WramLayout = {
  dataAddr: 0xC100,
  initializedAddr: 0xC1C0,
  stackAddr: 0xC300,
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

/**
 * Find a safe WRAM layout for the player's variables and stack.
 * Needs 3 contiguous free 256-byte pages: DATA, INITIALIZED+gap, stack.
 * Returns DEFAULT_WRAM_LAYOUT if the default range is safe.
 */
export function findSafeWramLayout(usedPages: Set<number>, stackPtr: number): WramLayout {
  // Also mark the GBS stack page as used (stackPtr and below).
  const stackPage = stackPtr >> 8;
  usedPages.add(stackPage);

  // Check if default layout is safe (pages 0xC1, 0xC2 for data+stack).
  const defaultPages = [0xC1, 0xC2, 0xC3];
  const defaultSafe = defaultPages.every(p => !usedPages.has(p));
  if (defaultSafe) return DEFAULT_WRAM_LAYOUT;

  // Search for 3 contiguous free pages in 0xC1-0xDE range.
  // (0xC0 is always GBS territory; 0xDF is near GBS stack.)
  const NEED = 3;
  let runStart = 0;
  let runLen = 0;

  for (let p = 0xC1; p <= 0xDE; p++) {
    if (!usedPages.has(p)) {
      if (runLen === 0) runStart = p;
      runLen++;
      if (runLen >= NEED) {
        const base = runStart << 8;
        return {
          dataAddr: base,
          initializedAddr: base + 0xC0,
          stackAddr: base + (NEED * 0x100),
        };
      }
    } else {
      runLen = 0;
    }
  }

  // No 3-page block found — fall back to default and warn.
  console.warn(
    "      WARNING: Could not find 3 contiguous free WRAM pages. " +
    "Using default layout — GBS audio may not work correctly."
  );
  return DEFAULT_WRAM_LAYOUT;
}
