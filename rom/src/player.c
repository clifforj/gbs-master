/**
 * GBS Playback Driver — calls GBS INIT/PLAY via trampolines.
 *
 * All GBS calls go through _gbs_init_trampoline / _gbs_play_trampoline
 * (defined in trampolines.s, always in bank 0).  In non-banked mode the
 * trampoline is a simple call+ret; in banked mode it handles MBC bank
 * switching around the GBS call.
 *
 * GBS stack pointer and other per-GBS values are read at runtime from the
 * config table at ROM address 0x0280 (see config.h).
 *
 * WRAM layout:
 *   0xC000-0xC0EF — GBS engine state (zeroed by INIT, managed by GBS)
 *   0xC100+       — Our C variables (_DATA, placed by linker)
 * GBS INIT's WRAM zeroing no longer reaches our variables.
 * The WRAM backup of player_current_track is kept as belt-and-suspenders.
 */

#include <stdint.h>

#include "hardware.h"
#include "player.h"
#include "config.h"
#include "track_data.h"

/* ── Module state ─────────────────────────────────────────────────────────── */

/* Lives in _DATA at 0xC100+ — safely above GBS INIT zeroing range.
   Still backed up to WRAM before each PLAY call (belt-and-suspenders). */
uint8_t player_current_track;

/* Actual GBS track number (1-based) to pass to INIT.
   When a playlist is used, this differs from player_current_track:
   player_current_track is the playlist index (1..GBS_NUM_TRACKS),
   player_gbs_track is the GBS track from the resource bank track data. */
uint8_t player_gbs_track;

/* SP save slots — in WRAM (safe from GBS INIT/PLAY).
   Previously in HRAM at 0xFF95-0xFF97, but some GBS drivers (e.g. DMG-FFJ)
   zero HRAM 0xFF90-0xFF9F during INIT, destroying those save slots. */
uint8_t sp_save_lo;
uint8_t sp_save_hi;

/* Backup of player_current_track across GBS PLAY calls. */
uint8_t player_track_save;


/* ── Internal helpers ─────────────────────────────────────────────────────── */

/* Call GBS INIT with the current track index.
   __naked: no SDCC prologue/epilogue — we manage registers manually.
   Entry: player_gbs_track holds the 1-based GBS track number.
   Register usage:
     HL — temporary for SP save/restore (add hl,sp is the only way to read SP)
     A  — SP bytes, then 0-based track index for GBS INIT
   SP is saved to WRAM (above the GBS INIT zeroing range).
   GBS stack pointer is read from the config table at 0x0284. */
static void player_call_init(void) __naked {
    __asm
        ; Copy SP into HL
        ld   hl, #0
        add  hl, sp
        ; Save SP to WRAM (safe from GBS INIT zeroing)
        ld   a, l
        ld   (_sp_save_lo), a
        ld   a, h
        ld   (_sp_save_hi), a
        ; Read GBS stack pointer from config table and set SP
        ld   a, (0x0284)          ; gbs_stack_ptr lo
        ld   l, a
        ld   a, (0x0285)          ; gbs_stack_ptr hi
        ld   h, a
        ld   sp, hl
        ; Call INIT with 0-based GBS track index in A
        ld   a, (_player_gbs_track)
        dec  a
        ; Call GBS INIT via bank-0 trampoline
        call _gbs_init_trampoline
        ; Restore SP from WRAM
        ld   a, (_sp_save_lo)
        ld   l, a
        ld   a, (_sp_save_hi)
        ld   h, a
        ld   sp, hl
        ret
    __endasm;
}

/* ── Public API ───────────────────────────────────────────────────────────── */

uint8_t player_get_current_track(void) {
    return player_current_track;
}

void player_init(void) {
    player_current_track = GBS_FIRST_TRACK;

    /* Zero GBS channel state area so PLAY does not skip audio on first call.
       Our WRAM clear in startup.s already zeroed this, but be explicit. */
    {
        uint8_t *p   = (uint8_t *)0xC000;
        uint8_t *end = (uint8_t *)0xC0F0;
        while (p < end) *p++ = 0;
    }

    /* Enable APU */
    NR52_REG = 0x80u;
    NR50_REG = 0x77u;
    NR51_REG = 0xFFu;
}

/* Call GBS PLAY once per frame (VBlank).
   __naked: no SDCC prologue/epilogue — we manage registers manually.
   Register usage:
     HL — temporary for SP save/restore
     A  — SP bytes, track backup, then register reset constants
   Saves player_current_track to WRAM before the call because GBS PLAY may
   corrupt WRAM in the 0xC000-0xC0EF range.  Resets LCDC, BGP, and IE after
   the call because GBS PLAY writes to video registers as a side-effect. */
void player_tick(void) __naked {
    __asm
        ; Backup player_current_track to WRAM before PLAY can touch it
        ld   a, (_player_current_track)
        ld   (_player_track_save), a
        ; Save SP to WRAM before switching to GBS stack
        ld   hl, #0
        add  hl, sp
        ld   a, l
        ld   (_sp_save_lo), a
        ld   a, h
        ld   (_sp_save_hi), a
        ; Read GBS stack pointer from config table and set SP
        ld   a, (0x0284)          ; gbs_stack_ptr lo
        ld   l, a
        ld   a, (0x0285)          ; gbs_stack_ptr hi
        ld   h, a
        ld   sp, hl
        ; Call GBS PLAY via bank-0 trampoline
        call _gbs_play_trampoline
        ; Restore SP
        ld   a, (_sp_save_lo)
        ld   l, a
        ld   a, (_sp_save_hi)
        ld   h, a
        ld   sp, hl
        ; Reset video registers to known-good constants.
        ; Faster than save/restore (no save step) and immune to stale state.
        ; SCY/SCX are corrected by ui_update / main loop — not set here.
        ld   a, #0xF3
        ldh  (0x40), a          ; LCDC: window on
        ld   a, #0xE4
        ldh  (0x47), a          ; BGP: standard palette
        ; Restore IE in case GBS PLAY changed it
        ld   a, #0x01
        ld   (0xFFFF), a        ; IE = VBL only
        ; Restore player_current_track
        ld   a, (_player_track_save)
        ld   (_player_current_track), a
        ret
    __endasm;
}

void player_set_track(uint8_t track_number) {
    if (track_number < 1u) track_number = 1u;
    if (track_number > GBS_NUM_TRACKS) track_number = GBS_NUM_TRACKS;

    player_current_track = track_number;
    player_gbs_track = get_gbs_track_number(track_number - 1u);

    player_call_init();
}

void player_next_track(void) {
    uint8_t next = player_current_track + 1u;
    if (next > GBS_NUM_TRACKS) next = 1u;
    player_set_track(next);
}

void player_prev_track(void) {
    uint8_t prev = (player_current_track <= 1u) ? GBS_NUM_TRACKS
                                                 : player_current_track - 1u;
    player_set_track(prev);
}
