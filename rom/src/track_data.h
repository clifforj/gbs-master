/* track_data.h — Access track metadata.
 *
 * Track data is stored in the resource bank at RES_TRACK_DATA.  Each resource
 * entry is 32 bytes: 1 byte gbs_track + 31 bytes null-terminated title.
 *
 * Bank switching to read the resource bank at runtime is UNSAFE for some
 * GBS drivers (e.g. Pokemon Blue, whose driver tracks the current MBC bank
 * in WRAM across banks 0-3): our mid-run writes to MBC_BANK_REG desync its
 * tracking, causing missing audio or crashes.  So we copy every track entry
 * verbatim into a WRAM cache once — before the first GBS INIT — and serve
 * every subsequent read from WRAM.
 *
 * The cache holds full 32-byte entries (same layout as the resource bank).
 * It can be split across up to three non-contiguous WRAM regions to
 * accommodate GBS files with heavily fragmented free WRAM:
 *   entries [0, cap_a)                      → cache_addr_a
 *   entries [cap_a, cap_a + cap_b)          → cache_addr_b
 *   entries [cap_a + cap_b, num_tracks)     → cache_addr_c
 * Unused trailing regions are set equal to the preceding one and their
 * capacity is 0, so region routing stays branch-cheap. */

#ifndef TRACK_DATA_H
#define TRACK_DATA_H

#include <stdint.h>

#define TRACK_CACHE_MAX_TRACKS 96u
#define TRACK_CACHE_ENTRY_SIZE 32u
#define TRACK_CACHE_TITLE_MAX  31u  /* includes null terminator */

/* Copy all track metadata from the resource bank into the WRAM cache.
 * MUST be called once BEFORE the first GBS INIT (i.e. before
 * player_set_track).  Safe to bank-switch here because the driver
 * has not yet run. */
void track_data_init(void);

/* Load a track title from the cache into a caller-provided buffer.
 * idx is 0-based.  buf must have room for TRACK_CACHE_TITLE_MAX bytes.
 * Result is null-terminated.  No bank switching. */
void load_track_title(uint8_t idx, char *buf);

/* Get the 1-based GBS track number for a given playlist index (0-based).
 * No bank switching. */
uint8_t get_gbs_track_number(uint8_t idx);

#endif /* TRACK_DATA_H */
