/**
 * GBS Playback Driver — no GBDK library.
 *
 * GBS INIT/PLAY call convention is unchanged from the GBDK version.
 * All __naked __asm/__endasm blocks are kept verbatim — they use raw
 * HRAM addresses and GBS_STACK_PTR which are independent of GBDK.
 *
 * WRAM layout improvement over GBDK version:
 *   0xC000-0xC0EF — GBS engine state (zeroed by INIT, managed by GBS)
 *   0xC100+       — Our C variables (_DATA/_BSS, placed by linker)
 * GBS INIT's WRAM zeroing no longer reaches our variables.
 * The HRAM backup of player_current_track is kept as belt-and-suspenders.
 */

#include <stdint.h>

#include "hardware.h"
#include "player.h"
#include "generated/playlist_data.h"

/* ── Module state ─────────────────────────────────────────────────────────── */

/* Lives in _DATA/_BSS at 0xC100+ — safely above GBS INIT zeroing range.
   Still backed up to HRAM before each PLAY call (belt-and-suspenders). */
uint8_t player_current_track;

/* Actual GBS track number (1-based) to pass to INIT.
   When a playlist is used, this differs from player_current_track:
   player_current_track is the playlist index (1..GBS_NUM_TRACKS),
   player_gbs_track is TRACK_LIST[player_current_track-1].gbs_track. */
uint8_t player_gbs_track;

/* SP save slots in HRAM — never touched by GBS drivers. */
__at(0xFF95) uint8_t sp_save_lo;
__at(0xFF96) uint8_t sp_save_hi;

/* Backup of player_current_track across GBS PLAY calls. */
__at(0xFF97) uint8_t player_track_save;


/* ── Internal helpers ─────────────────────────────────────────────────────── */

/* Call GBS INIT with the current track index.
   __naked: no SDCC prologue/epilogue — we manage registers manually.
   Entry: player_gbs_track holds the 1-based GBS track number.
   Register usage:
     HL — temporary for SP save/restore (add hl,sp is the only way to read SP)
     A  — SP bytes for HRAM save, then 0-based track index for GBS INIT
   SP is saved to HRAM (not WRAM) because GBS INIT zeros WRAM 0xC000-0xC0EF. */
static void player_call_init(void) __naked {
    __asm
        ; Copy SP into HL
        ld   hl, #0
        add  hl, sp
        ; Save GBDK SP to HRAM (GBS INIT zeros WRAM, so WRAM is unsafe)
        ld   a, l
        ldh  (_sp_save_lo), a
        ld   a, h
        ldh  (_sp_save_hi), a
        ; Switch to the stack pointer expected by the GBS driver
        ld   sp, #GBS_STACK_PTR
        ; Call INIT with 0-based GBS track index in A
        ld   a, (_player_gbs_track)
        dec  a
#if BANKED_CODE
        ; In banked mode, call the bank-0 trampoline which calls GBS INIT
        ; then restores the code bank before returning here.
        call _gbs_init_trampoline
#else
        call GBS_INIT_ADDR
#endif
        ; Restore SP from HRAM
        ldh  a, (_sp_save_lo)
        ld   l, a
        ldh  a, (_sp_save_hi)
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
   Saves player_current_track to HRAM before the call because GBS PLAY may
   corrupt WRAM variables.  Resets LCDC, BGP, and IE after the call because
   GBS PLAY writes to video registers as a side-effect of being extracted
   from a running game (the original game used these for scroll/palette). */
void player_tick(void) __naked {
    __asm
        ; Backup player_current_track to HRAM before PLAY can touch it
        ld   a, (_player_current_track)
        ldh  (_player_track_save), a
        ; Save SP to HRAM before switching to GBS stack
        ld   hl, #0
        add  hl, sp
        ld   a, l
        ldh  (_sp_save_lo), a
        ld   a, h
        ldh  (_sp_save_hi), a
        ; Switch to GBS stack and call PLAY
        ld   sp, #GBS_STACK_PTR
#if BANKED_CODE
        ; In banked mode, call the bank-0 trampoline which calls GBS PLAY
        ; then restores the code bank before returning here.
        call _gbs_play_trampoline
#else
        call GBS_PLAY_ADDR
#endif
        ; Restore SP
        ldh  a, (_sp_save_lo)
        ld   l, a
        ldh  a, (_sp_save_hi)
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
        ldh  a, (_player_track_save)
        ld   (_player_current_track), a
        ret
    __endasm;
}

void player_set_track(uint8_t track_number) {
    if (track_number < 1u) track_number = 1u;
    if (track_number > GBS_NUM_TRACKS) track_number = GBS_NUM_TRACKS;

    player_current_track = track_number;
    player_gbs_track = TRACK_LIST[track_number - 1u].gbs_track;

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
