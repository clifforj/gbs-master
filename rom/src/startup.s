; startup.s — Game Boy ROM skeleton
; Assembled with: sdasgb -o build/startup.rel src/startup.s
;
; Owns 0x0000-0x014F: RST vectors, hardware interrupt vectors, ROM header.
; Startup routine at 0x0150: stack, WRAM clear, APU, font→VRAM, LCD enable,
; VBL interrupt, then calls C _main.
; Font data follows the startup code (59 chars × 7 bytes, ASCII 0x20-0x5A).

.area _STARTUP (ABS)

; External symbol: _entry is provided by the generated trampolines.s.
; In non-banked mode, _entry just jumps to _main.
; In banked mode, _entry switches to the code bank first.
.globl _entry

; ── RST vectors ──────────────────────────────────────────────────────────────
.org 0x0000
    reti
.org 0x0008
    reti
.org 0x0010
    reti
.org 0x0018
    reti
.org 0x0020
    reti
.org 0x0028
    reti
.org 0x0030
    reti
.org 0x0038
    reti

; ── Hardware interrupt vectors ────────────────────────────────────────────────
.org 0x0040
; VBlank ISR: set HRAM flag, reset window state for next frame.
_vbl_isr::
    jp   _vbl_handler

.org 0x0048
    reti                    ; STAT ISR (LCD status — unused)
.org 0x0050
    reti                    ; Timer ISR (unused)
.org 0x0058
    reti                    ; Serial ISR (unused)
.org 0x0060
    reti                    ; Joypad ISR (unused)

; ── ROM entry point ───────────────────────────────────────────────────────────
.org 0x0100
    nop
    jp   _start

; ── Nintendo logo (48 bytes, checked by boot ROM) ────────────────────────────
.org 0x0104
    .db 0xCE, 0xED, 0x66, 0x66, 0xCC, 0x0D, 0x00, 0x0B
    .db 0x03, 0x73, 0x00, 0x83, 0x00, 0x0C, 0x00, 0x0D
    .db 0x00, 0x08, 0x11, 0x1F, 0x88, 0x89, 0x00, 0x0E
    .db 0xDC, 0xCC, 0x6E, 0xE6, 0xDD, 0xDD, 0xD9, 0x99
    .db 0xBB, 0xBB, 0x67, 0x63, 0x6E, 0x0E, 0xEC, 0xCC
    .db 0xDD, 0xDC, 0x99, 0x9F, 0xBB, 0xB9, 0x33, 0x3E

; ── Cartridge header (0x0134-0x014F) ─────────────────────────────────────────
; Checksum, cart type, and ROM size are patched by builder.ts embedGbs().
.org 0x0134
    .ascii "GBSMASTER  "    ; title bytes 0-10 (11 chars)
    .db 0x00, 0x00, 0x00, 0x00, 0x00  ; title bytes 11-15 (pad to 16)
    .db 0x00, 0x00          ; new licensee code
    .db 0x00                ; SGB flag
    .db 0x00                ; cart type  (patched by embedGbs)
    .db 0x00                ; ROM size   (patched by embedGbs)
    .db 0x00                ; RAM size
    .db 0x01                ; destination (non-Japanese)
    .db 0x33                ; old licensee (0x33 = use new licensee field)
    .db 0x00                ; ROM version
    .db 0x00                ; header checksum (patched by embedGbs)
    .db 0x00, 0x00          ; global checksum (patched by embedGbs)

; ── Startup routine ───────────────────────────────────────────────────────────
.org 0x0150
_start::
    ; Stack in WRAM, above our C variables (_DATA ends ~0xC150).
    ; MUST NOT be in HRAM (0xFFE0-0xFFFE) — many GBS drivers use that
    ; range as APU shadow registers and will overwrite our return addresses.
    ld   sp, #0xC300

    ; Zero all WRAM (0xC000-0xDFFF, 8192 bytes).
    ; Clears both our BSS variables (at 0xC100+) and the GBS engine area.
    ; GBS INIT will re-init its own area; we re-init ours via player_init().
    ; NOTE: use dec c / dec b pattern so A=0 is never destroyed by the check.
    ld   hl, #0xC000
    ld   bc, #0x2000
    xor  a
_zero_wram:
    ld   (hl+), a
    dec  c
    jr   nz, _zero_wram
    dec  b
    jr   nz, _zero_wram

    ; Zero HRAM (0xFF80-0xFFFE, 127 bytes).
    ; Many GBS drivers read HRAM flags set by the original game code.
    ; If uninitialized, stale values can cause the driver to skip
    ; sound update routines entirely (e.g. Zelda checks 0xFFF3).
    ld   hl, #0xFF80
    ld   c, #127
    xor  a
_zero_hram:
    ld   (hl+), a
    dec  c
    jr   nz, _zero_hram

    ; Enable APU before any GBS calls
    ld   a, #0x80
    ld   (0xFF26), a        ; NR52: APU master enable
    ld   a, #0x77
    ld   (0xFF24), a        ; NR50: max volume L+R
    ld   a, #0xFF
    ld   (0xFF25), a        ; NR51: all channels to L+R

    ; The DMG boot ROM leaves the LCD ON when it hands off to our code.
    ; VRAM writes are ignored while the LCD is in active-display mode (mode 3).
    ; We must disable the LCD before writing font tiles or the tile map.
    ; Hardware rule: only disable LCD during VBlank (LY >= 144).
_wait_vbl:
    ld   a, (0xFF44)        ; LY — current scanline
    cp   #144
    jr   c, _wait_vbl       ; loop while LY < 144 (still in active display)
    ; Now in VBlank — safe to turn off the LCD
    xor  a
    ld   (0xFF40), a        ; LCDC = 0: LCD off (VRAM fully accessible)

    ; Font tiles are NOT loaded here — they live in the resource bank and
    ; are copied to VRAM by reload_tiles() in ui.c (called from ui_init).
    ; This avoids the GBS embedding overwriting font const data in bank 0.

    ; Clear background tile map (0x9800-0x9BFF, 1024 bytes) to tile 0 (space)
    ; NOTE: use dec c / dec b pattern so A=0 is never destroyed by the check.
    ld   hl, #0x9800
    ld   bc, #0x0400
    xor  a
_clear_map:
    ld   (hl+), a
    dec  c
    jr   nz, _clear_map
    dec  b
    jr   nz, _clear_map

    ; Clear OAM (0xFE00-0xFE9F, 160 bytes) so no random sprites appear
    ld   hl, #0xFE00
    ld   c, #160
    xor  a
_clear_oam:
    ld   (hl+), a
    dec  c
    jr   nz, _clear_oam

    ; Clear window tile map (0x9C00-0x9FFF, 1024 bytes) to space tile
    ; Must happen while LCD is off (VRAM accessible).
    ld   hl, #0x9C00
    ld   bc, #0x0400
    ld   a, #95             ; soft font space tile (SOFT_FONT_BASE)
_clear_win_map:
    ld   (hl+), a
    dec  c
    jr   nz, _clear_win_map
    dec  b
    jr   nz, _clear_win_map

    ; Set up window registers (before LCD enable)
    ; WY=112: window appears at scanline 112, covering bottom 4 tile rows (32 px).
    ; No STAT interrupt needed — hardware WY handles visibility.
    ld   a, #112
    ld   (0xFF4A), a        ; WY = 112 (window covers bottom 4 rows)
    ld   a, #7
    ld   (0xFF4B), a        ; WX = 7 (window at screen column 0)

    ; Standard DMG palette and enable LCD
    ld   a, #0xE4
    ld   (0xFF47), a        ; BGP:  00=white 01=lgray 10=dgray 11=black
    ld   a, #0xE4
    ld   (0xFF48), a        ; OBP0: same palette as BG (colour 0 = transparent)
    ld   a, #0xF3
    ld   (0xFF40), a        ; LCDC: LCD on, WIN map 0x9C00, WIN on, OBJ on, BG on, tiles 0x8000

    ; Clear VBL flag before enabling interrupts
    xor  a
    ld   (0xFF80), a        ; VBL_FLAG = 0

    ; Enable VBlank interrupt only (no STAT needed)
    ld   a, #0x01
    ld   (0xFFFF), a        ; IE = VBL only
    ei

    ; Transfer control to C main() via the entry trampoline.
    ; In non-banked mode, _entry simply jumps to _main.
    ; In banked mode, _entry switches to the code bank first.
    call _entry

_halt_loop:
    halt
    jr   _halt_loop


; ── ISR handlers (placed here to avoid size limits in vector slots) ───────────

_vbl_handler:
    push af
    ld   a, #1
    ld   (0xFF80), a        ; VBL_FLAG = 1
    pop  af
    reti
