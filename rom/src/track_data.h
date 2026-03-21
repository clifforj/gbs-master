/* track_data.h — Access track metadata stored in the resource bank.
 *
 * Track data lives in the resource bank at RES_TRACK_DATA.
 * Each entry is 32 bytes: 1 byte gbs_track + 31 bytes null-terminated title.
 * These helpers handle bank switching to safely read from the resource bank. */

#ifndef TRACK_DATA_H
#define TRACK_DATA_H

#include <stdint.h>

/* Load a track title from the resource bank into a WRAM buffer.
 * idx is 0-based (0 = first track in playlist).
 * buf must have room for 31 bytes. The result is null-terminated. */
void load_track_title(uint8_t idx, char *buf);

/* Get the 1-based GBS track number for a given playlist index (0-based).
 * This is the value passed to GBS INIT (after subtracting 1). */
uint8_t get_gbs_track_number(uint8_t idx);

#endif /* TRACK_DATA_H */
