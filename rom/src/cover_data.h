/* cover_data.h — VRAM tile indices for the 2x2 album cover.
 * Tile data is loaded from the resource bank at runtime by ui_init(). */

#ifndef COVER_DATA_H
#define COVER_DATA_H

/* VRAM tile indices for the 2x2 album cover (tiles 234-237). */
#define COVER_TILE_BASE  234
#define COVER_TILE_TL    234
#define COVER_TILE_TR    235
#define COVER_TILE_BL    236
#define COVER_TILE_BR    237
#define COVER_TILE_COUNT 4

/* VRAM address where cover tiles start: 0x8000 + 234 * 16 = 0x8EA0. */
#define COVER_VRAM_BASE  ((volatile uint8_t*)0x8EA0u)

#endif /* COVER_DATA_H */
