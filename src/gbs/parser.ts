/**
 * GBS parser — Node.js entry point.
 *
 * Re-exports the pure parser from parse-gbs.ts (browser-safe) and adds
 * the file-reading wrapper that requires Node.js fs.
 */

import { readFile } from "fs/promises";
import type { ParsedGbs } from "./types.js";

// Re-export everything from the pure parser so existing Node imports still work.
export { parseGbs, parseGbs as parseGbsBuffer } from "./parse-gbs.js";

/**
 * Parse a GBS file from disk and return the structured header plus derived
 * values needed by the ROM builder.
 */
export async function parseGbsFile(filePath: string): Promise<ParsedGbs> {
  const { parseGbs } = await import("./parse-gbs.js");
  const raw = new Uint8Array(await readFile(filePath));
  return parseGbs(raw);
}
