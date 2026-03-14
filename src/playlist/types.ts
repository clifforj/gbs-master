/** Metadata for a single track, enriching what the GBS header provides. */
export interface Track {
  /** 1-indexed track number (matches the value passed to the GBS INIT routine + 1). */
  number: number;
  /** Human-readable track title shown in the player UI. */
  title: string;
}

/**
 * A playlist file ties a GBS file to enriched per-track metadata.
 *
 * The file is stored as JSON and edited by hand (or generated as a template
 * via `npm run playlist:init`).
 */
export interface Playlist {
  /** Path to the GBS file this playlist describes (relative to the playlist file). */
  gbs: string;
  /** Optional override for the album title (defaults to the GBS header title). */
  title?: string;
  /** Per-track data, in any order (the build tool will sort by `number`). */
  tracks: Track[];
}
