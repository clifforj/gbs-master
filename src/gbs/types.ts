/**
 * Parsed representation of the 112-byte GBS file header.
 *
 * GBS (Game Boy Sound) files begin with a fixed header followed immediately
 * by the music driver code. When embedded into a .gb ROM, the music code is
 * placed at ROM byte offset (loadAddr - 0x70) so that it lands at `loadAddr`
 * in the Game Boy's address space.
 */
export interface GbsHeader {
  /** Always "GBS" */
  magic: string;
  /** Always 1 */
  version: number;
  /** Total number of tracks in this file */
  numSongs: number;
  /** 1-indexed number of the default track to play on startup */
  firstSong: number;
  /**
   * Where the GBS music code lives in Game Boy memory (0x0000–0x7FFF).
   * Minimum valid value is 0x0470 — the player ROM occupies 0x0000–0x03FF,
   * and the GBS header itself occupies the 0x70 bytes immediately before
   * the music code.
   */
  loadAddr: number;
  /**
   * Game Boy address of the track initialisation routine.
   * Called with the 0-based track index in CPU register A.
   */
  initAddr: number;
  /**
   * Game Boy address of the per-frame playback routine.
   * Called every VBlank (or timer) interrupt while music is active.
   */
  playAddr: number;
  /** Initial Stack Pointer value expected by the GBS music code. */
  stackPtr: number;
  /** Loaded into the TMA (Timer Modulo) register when timer mode is active. */
  timerModulo: number;
  /**
   * Loaded into the TAC (Timer Control) register.
   * Bits 0–1: clock select. Bit 2: enable timer.
   * Bit 6 (GBS extension): if set, use timer interrupt instead of VBlank.
   */
  timerControl: number;
  /** Album / game title — up to 32 ASCII characters. */
  title: string;
  /** Composer / author name — up to 32 ASCII characters. */
  author: string;
  /** Copyright line — up to 32 ASCII characters. */
  copyright: string;
}

/** Everything produced after fully parsing a GBS file. */
export interface ParsedGbs {
  header: GbsHeader;
  /** Raw bytes of the entire GBS file (header + music data). */
  raw: Buffer;
  /**
   * Byte offset within the final GB ROM where the full GBS file is written.
   * Formula: header.loadAddr - GBS_HEADER_SIZE
   */
  gbsRomOffset: number;
  /**
   * True when the GBS file expects a timer interrupt for playback;
   * false when it uses VBlank (the common case).
   */
  usesTimerInterrupt: boolean;
}

/** Size of the GBS file header in bytes. */
export const GBS_HEADER_SIZE = 0x70;
