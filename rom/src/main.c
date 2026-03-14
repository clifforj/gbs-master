/**
 * GBS Player — main entry point (no GBDK library)
 *
 * Startup sequence is handled by startup.s (_start):
 *   - Stack at 0xFFFE (HRAM)
 *   - WRAM zeroed (0xC000-0xDFFF)
 *   - APU enabled
 *   - Font loaded into VRAM
 *   - LCD enabled
 *   - VBlank interrupt enabled
 *   - Calls main()
 *
 * The VBL ISR (in startup.s) sets HRAM[0xFF80] (VBL_FLAG) each VBlank.
 * vbl_wait() polls this flag, replacing GBDK's vsync()/halt approach.
 *
 * Input mapping:
 *   Up / Down   — move list cursor (does not change playing track)
 *   A           — play the track under the cursor
 *   Left / Right — skip to prev / next track (cursor follows playing track)
 */

#include <stdint.h>

#include "hardware.h"
#include "input.h"
#include "player.h"
#include "ui.h"
#include "generated/playlist_data.h"

static void vbl_wait(void) {
    /* Require BOTH: VBL_FLAG set by ISR AND LY in VBlank range.
       This discards stale flags that were set while GBS INIT ran
       across a VBlank boundary, which would otherwise cause VRAM
       writes to happen during active display and be silently dropped. */
    while (!VBL_FLAG || LY_REG < 144u) {}
    VBL_FLAG = 0;
}

void main(void) {
    /* Switch SP to the dynamically-chosen safe WRAM region.
       startup.s uses a temporary SP (0xC300) for the initial WRAM clear and
       call to main.  We immediately move SP here to avoid conflicting with
       WRAM addresses the GBS sound driver may use.  main() never returns,
       so the lost return address from startup.s is harmless. */
    __asm
        ld   sp, #PLAYER_STACK_PTR
    __endasm;

    /* ── Initialise subsystems ────────────────────────────────────────────── */
    input_init();
    player_init();

    /* ── Draw initial UI ─────────────────────────────────────────────────── */
    vbl_wait();
    ui_init();

    /* ── Start playing the first track ───────────────────────────────────
       Must happen AFTER ui_init() because reload_tiles() changes the MBC
       bank register.  GBS INIT sets up driver state (including the active
       bank in WRAM) that must not be disturbed before the first PLAY call. */
    player_set_track(GBS_FIRST_TRACK);

    /* ── Main loop ────────────────────────────────────────────────────────
       Each iteration: wait for VBlank, refresh UI first (VRAM/OAM writes
       must happen early in VBlank for reliability), then call GBS PLAY
       (STAT interrupt is disabled during the call to prevent ISR
       malfunction from DMA or STAT register corruption; video registers
       are reset to known-good constants immediately after), reset
       remaining regs, read input, handle navigation. */
    while (1) {
        vbl_wait();

        /* Update UI at the very start of VBlank — VRAM is accessible here.
           VRAM/OAM writes must happen early for reliability. */
        ui_update();

        player_tick();

        /* Reset remaining registers that GBS PLAY may have corrupted.
           LCDC, BGP, and STAT are already reset inside player_tick().
           SCY/SCX are set here and by ui_update (belt-and-suspenders). */
        *SCY_REG  = ui_get_scy(); /* SCY — restore animated scroll */
        *SCX_REG  = 0u;           /* SCX  */
        *OBP0_REG = BGP_DEFAULT;  /* OBP0 (sprite palette) */
        *WY_REG   = 112u;         /* WY = 112 (bottom 4 rows) */
        *WX_REG   = 7u;           /* WX = 7 (window at column 0) */

        input_update();

        if (input_pressed(J_UP)) {
            ui_cursor_up();
        }
        if (input_pressed(J_DOWN)) {
            ui_cursor_down();
        }
        if (input_pressed(J_A)) {
            /* Play the track under the cursor. */
            player_set_track(ui_cursor_get() + 1u);
        }
        if (input_pressed(J_RIGHT)) {
            player_next_track();
        }
        if (input_pressed(J_LEFT)) {
            player_prev_track();
        }

        /* Pre-compute tile data for the next row that will scroll into view.
           Runs outside VBlank — string processing has no timing constraint.
           The staged buffer is flushed to VRAM by ui_update() next VBlank. */
        ui_prepare();
    }
}
