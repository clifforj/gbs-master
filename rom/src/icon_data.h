/* icon_data.h — VRAM tile indices for UI icons.
 * Tile data is loaded from the resource bank at runtime by ui_init(). */

#ifndef ICON_DATA_H
#define ICON_DATA_H

/* VRAM tile indices for each icon (tiles 230-233). */
#define ICON_CURSOR_TILE  230
#define ICON_PLAYING_TILE 231
#define ICON_ALBUM_TILE   232
#define ICON_TRACK_TILE   233

#define ICON_TILE_COUNT   4
#define ICON_TILE_BASE    230

/* VRAM address where icon tiles start: 0x8000 + 230 * 16 = 0x8E60. */
#define ICON_VRAM_BASE  ((volatile uint8_t*)0x8E60u)

#endif /* ICON_DATA_H */
