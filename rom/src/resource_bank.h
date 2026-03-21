/* resource_bank.h — Fixed offsets into the resource bank ROM window.
 *
 * The resource bank number varies per build and is stored in the config
 * table (RESOURCE_BANK_NUM from config.h).  The data layout within the
 * 0x4000-0x7FFF bank window is always the same.
 *
 * Select the resource bank via MBC1 before dereferencing these pointers. */

#ifndef RESOURCE_BANK_H
#define RESOURCE_BANK_H

#include <stdint.h>

/* Font tile data: 95 tiles x 16 bytes = 1520 bytes. */
#define RES_FONT_DATA       ((const uint8_t*)0x4000u)
#define RES_FONT_DATA_SIZE  1520u

/* Per-character advance widths: 95 bytes. */
#define RES_FONT_WIDTHS     ((const uint8_t*)0x45F0u)
#define RES_FONT_WIDTHS_SIZE 95u

/* Soft font tile data: 102 tiles x 16 bytes = 1632 bytes. */
#define RES_SOFT_FONT       ((const uint8_t*)0x464Fu)
#define RES_SOFT_FONT_SIZE  1632u

/* Icon tile data: 4 tiles x 16 bytes = 64 bytes. */
#define RES_ICON_TILES      ((const uint8_t*)0x4CAFu)
#define RES_ICON_TILES_SIZE 64u

/* Cover tile data: 4 tiles x 16 bytes = 64 bytes. */
#define RES_COVER_TILES     ((const uint8_t*)0x4CEFu)
#define RES_COVER_TILES_SIZE 64u

/* Track data: 32 bytes per track (1 byte gbs_track + 31 bytes title). */
#define RES_TRACK_DATA       ((const uint8_t*)0x4D2Fu)
#define RES_TRACK_ENTRY_SIZE 32u

#endif /* RESOURCE_BANK_H */
