#ifndef UI_H
#define UI_H

#include <stdint.h>

/**
 * Initialise VRAM scratch layout and draw the initial track list.
 * Call once after startup and the first player_set_track().
 */
void ui_init(void);

/**
 * Stage tile data for the next pending row into a WRAM buffer.
 * Call once per frame OUTSIDE VBlank (e.g. after input handling).
 * String processing happens here so it has no timing constraint.
 */
void ui_prepare(void);

/**
 * Flush staged VRAM writes, update sprites and SCY.
 * Call once per frame DURING VBlank (immediately after vbl_wait()).
 * Only does fast byte copies — guaranteed to fit within VBlank.
 */
void ui_update(void);

/** Move the list cursor one row up (does not change the playing track). */
void ui_cursor_up(void);

/** Move the list cursor one row down (does not change the playing track). */
void ui_cursor_down(void);

/**
 * Jump the cursor to a specific 0-based track index and re-centre the view.
 * Used when left/right skip the playing track so the cursor follows.
 */
void ui_cursor_set(uint8_t idx);

/** Return the current cursor position (0-based track index). */
uint8_t ui_cursor_get(void);

/** Return the current animated SCY value.
 *  Use this to restore SCY after player_tick() overwrites it. */
uint8_t ui_get_scy(void);

#endif /* UI_H */
