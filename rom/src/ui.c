/**
 * Smooth-scrolling track list using GB hardware SCY register.
 *
 * Ring-buffer tilemap: track i maps to tilemap row (i & 31).
 * SCY = (scroll_top * 8) % 256 — the hardware wrap aligns with the ring buffer,
 * so no seam correction is needed even when the view straddles row 31/0.
 *
 * Scroll behaviour:
 *   Cursor is locked to CENTER_ROW while the view scrolls.
 *   It moves freely only near the top/bottom of the full list.
 *
 * Two-phase rendering (eliminates VBlank overflow):
 *   ui_prepare() — called OUTSIDE VBlank after input handling.
 *     Computes tile indices for the next pending row into a WRAM staging
 *     buffer.  String processing + ROM reads have no timing constraint.
 *   ui_update()  — called DURING VBlank (immediately after vbl_wait).
 *     Fast 20-byte VRAM copy from the staging buffer, then sprites + SCY.
 *     Total VBlank cost: ~250 cycles, well within the ~1140-cycle budget.
 *
 * Sprite positions use the pixel-accurate formula:
 *   OAM Y = (uint8_t)((track_idx & 31) * 8 - s_scy) + 16
 * This tracks the text during animation automatically via uint8_t wrap.
 *
 * Now-playing name on the bottom window overlay:
 *   Uses 20 scratch VRAM tiles (197-216) with the condensed proportional
 *   font.  Glyph bits are blitted at sub-tile pixel offsets so characters
 *   pack tightly.  The window tilemap bottom row (row 5) points to these
 *   scratch tiles.  Reblitted (with LCD off) only on track changes.
 */

#include <stdint.h>
#include "hardware.h"
#include "ui.h"
#include "player.h"
#include "config.h"
#include "resource_bank.h"
#include "icon_data.h"
#include "cover_data.h"
#include "track_data.h"

/* Visible tile rows = screen height in tiles (144 / 8).
   The bottom window overlay hides BG rows 14-17 (LY 112-143).
   LIST_PAD_TOP=0 (no top padding), LIST_PAD_BOTTOM=4 (bottom padding). */
#define N_ROWS       18u

/* Tilemap row the cursor is locked to during mid-list scrolling (0-based).
   Center of the visible 14-row area (rows 0-13) = row 7. */
#define CENTER_ROW    7u

/* Total tilemap rows (hardware BG map height). */
#define TMAP_ROWS    32u

/* Pixels moved per frame toward scroll target. */
#define SCROLL_SPEED  2u

/* Blank padding rows before first track and after last track. */
#define LIST_PAD_TOP     0u
#define LIST_PAD_BOTTOM  4u

/* Total virtual rows: top padding + tracks + bottom padding. */
#define TOTAL_ITEMS  ((uint8_t)(GBS_NUM_TRACKS + LIST_PAD_TOP + LIST_PAD_BOTTOM))

/* Tile indices. */
#define SOFT_FONT_BASE  95u
#define TILE_ELLIPSIS   (SOFT_FONT_BASE + (0x85u - 0x20u))
#define TILE_CURSOR     ICON_CURSOR_TILE
#define TILE_PLAYING    ICON_PLAYING_TILE
#define SPRITE_X         8u   /* OAM X has 8-px offset; X=8 -> screen column 0 */

/* Scratch tiles for the now-playing name on the bottom window overlay.
   Tiles 197-212 (16 tiles = 128 px).  VRAM address = 0x8000 + tile * 16. */
#define SCRATCH_NAME_BASE  197u
#define SCRATCH_NAME_VRAM  ((volatile uint8_t*)0x8C50u)  /* 0x8000 + 197*16 */

/* Scratch tiles for the album title on the bottom window overlay.
   Tiles 213-228 (16 tiles = 128 px).  VRAM address = 0x8000 + 213*16. */
#define SCRATCH_TITLE_BASE 213u
#define SCRATCH_TITLE_VRAM ((volatile uint8_t*)0x8D50u)  /* 0x8000 + 213*16 */

/* Border tile: 1px light grey line at top, rest white.
   Tile 229, VRAM address = 0x8000 + 229*16 = 0x8E50. */
#define TILE_BORDER        229u
#define TILE_BORDER_VRAM   ((volatile uint8_t*)0x8E50u)

/* Window tilemap rows.
   With WY=112, the window renders rows 0-3 at LY 112-143.
   Row 0 (LY 112-119): border (1px light grey line at top, 7px padding).
   Row 1 (LY 120-127): album title.
   Row 2 (LY 128-135): now-playing track name. */
#define WIN_BORDER_ROW ((volatile uint8_t*)0x9C00u) /* row 0 = 0x9C00 */
#define WIN_TITLE_ROW  ((volatile uint8_t*)0x9C20u) /* row 1 = 0x9C00 + 1*32 */
#define WIN_NAME_ROW   ((volatile uint8_t*)0x9C40u) /* row 2 = 0x9C00 + 2*32 */

/* ── State ─────────────────────────────────────────────────────────────────── */

static uint8_t s_cursor      = 0u;   /* cursor position, absolute track index  */
static uint8_t s_scroll_top  = 0u;   /* track index at top of visible window   */
static uint8_t s_target_scy  = 0u;   /* target SCY (scroll_top * 8, mod 256)   */
static uint8_t s_scy         = 0u;   /* current animated SCY                   */
static uint8_t s_last_scroll = 0u;   /* scroll_top at last render (for delta)  */
static uint8_t s_pending_row = 0u;   /* row staged in s_row_buf (0xFF = none)  */

/* Ring-buffer cache: s_row_content[r] = track index stored in tilemap row r.
   0xFF means the row has not been rendered yet. */
static uint8_t s_row_content[32];

/* WRAM staging buffer: tile indices for one tilemap row (20 columns). */
static uint8_t s_row_buf[20];

/* Track number last blitted to the name scratch tiles (0 = none drawn). */
static uint8_t s_name_track = 0u;

/* WRAM copy of the 95-byte font_widths table (per-character advance widths).
   Copied once from the resource bank during ui_init so blit_string never
   needs to bank-switch at runtime. */
static uint8_t s_font_widths[95];

/* WRAM buffer for track titles loaded from the resource bank.
   31 bytes + 1 for safety (entries are 31-byte null-terminated). */
static char s_title_buf[32];

/* ── Font reload ──────────────────────────────────────────────────────────── */

/* Reload all tile data into VRAM from the resource bank.
   LCD MUST be off before calling.  Selects the resource bank via MBC1
   and leaves it selected on return (caller may continue reading).

   In BANKED_CODE mode, the player code lives in the switchable bank
   (0x4000-0x7FFF).  Switching MBC to the resource bank would unmap
   the code we are executing from.  So we use the bank-0 banked_copy()
   helper to safely switch banks, copy data, and restore the code bank. */
static void reload_tiles(void) {
#if BANKED_CODE
    /* Border tile (229): 1px grey + 1px black at top, rest white.
       These go directly to VRAM — no bank switching needed. */
    TILE_BORDER_VRAM[0] = 0xFFu;
    TILE_BORDER_VRAM[1] = 0x00u;
    TILE_BORDER_VRAM[2] = 0xFFu;
    TILE_BORDER_VRAM[3] = 0xFFu;
    {
        uint8_t b;
        for (b = 4u; b < 16u; b++) TILE_BORDER_VRAM[b] = 0x00u;
    }

    /* Condensed font: 95 tiles at VRAM 0x8000 (1520 bytes). */
    bcopy_params.bank = RESOURCE_BANK_NUM;
    bcopy_params.src  = RES_FONT_DATA;
    bcopy_params.dst  = (uint8_t*)0x8000u;
    bcopy_params.len  = RES_FONT_DATA_SIZE;
    banked_copy();

    /* Soft font: 102 tiles at VRAM 0x85F0 (1632 bytes). */
    bcopy_params.src  = RES_SOFT_FONT;
    bcopy_params.dst  = (uint8_t*)0x85F0u;
    bcopy_params.len  = RES_SOFT_FONT_SIZE;
    banked_copy();

    /* Icon tiles (4 tiles, 64 bytes). */
    bcopy_params.src  = RES_ICON_TILES;
    bcopy_params.dst  = (uint8_t*)ICON_VRAM_BASE;
    bcopy_params.len  = (uint16_t)(ICON_TILE_COUNT * 16u);
    banked_copy();

    /* Cover tiles (4 tiles, 64 bytes). */
    bcopy_params.src  = RES_COVER_TILES;
    bcopy_params.dst  = (uint8_t*)COVER_VRAM_BASE;
    bcopy_params.len  = (uint16_t)(COVER_TILE_COUNT * 16u);
    banked_copy();

    /* Copy font widths to WRAM so blit_string never needs bank switching. */
    bcopy_params.src  = RES_FONT_WIDTHS;
    bcopy_params.dst  = (uint8_t*)s_font_widths;
    bcopy_params.len  = 95u;
    banked_copy();
#else
    uint16_t i;
    volatile uint8_t *dst;
    const uint8_t *src;
    uint8_t b;

    MBC_BANK_REG = RESOURCE_BANK_NUM;

    /* Condensed font: 95 tiles at VRAM 0x8000 (1520 bytes). */
    src = RES_FONT_DATA;
    dst = (volatile uint8_t*)0x8000u;
    for (i = 0u; i < RES_FONT_DATA_SIZE; i++) dst[i] = src[i];

    /* Soft font: 102 tiles at VRAM 0x85F0 (1632 bytes). */
    src = RES_SOFT_FONT;
    dst = (volatile uint8_t*)0x85F0u;
    for (i = 0u; i < RES_SOFT_FONT_SIZE; i++) dst[i] = src[i];

    /* Border tile (229): 1px grey + 1px black at top, rest white. */
    TILE_BORDER_VRAM[0] = 0xFFu;
    TILE_BORDER_VRAM[1] = 0x00u;
    TILE_BORDER_VRAM[2] = 0xFFu;
    TILE_BORDER_VRAM[3] = 0xFFu;
    for (b = 4u; b < 16u; b++) TILE_BORDER_VRAM[b] = 0x00u;

    /* Icon tiles (4 tiles, 64 bytes). */
    src = RES_ICON_TILES;
    for (b = 0u; b < (uint8_t)(ICON_TILE_COUNT * 16u); b++)
        ICON_VRAM_BASE[b] = src[b];

    /* Cover tiles (4 tiles, 64 bytes). */
    src = RES_COVER_TILES;
    for (b = 0u; b < (uint8_t)(COVER_TILE_COUNT * 16u); b++)
        COVER_VRAM_BASE[b] = src[b];

    /* Copy font widths to WRAM so blit_string never needs bank switching. */
    src = RES_FONT_WIDTHS;
    for (b = 0u; b < 95u; b++)
        s_font_widths[b] = src[b];
#endif
}

/* ── Scroll helpers ────────────────────────────────────────────────────────── */

static uint8_t desired_scroll_top(uint8_t cursor) {
    uint8_t vpos = cursor + LIST_PAD_TOP;
    uint8_t mst;
    uint8_t t;
    if (TOTAL_ITEMS <= N_ROWS) return 0u;
    mst = TOTAL_ITEMS - N_ROWS;
    if (vpos <= CENTER_ROW) return 0u;
    t = vpos - CENTER_ROW;
    return (t > mst) ? mst : t;
}

/* ── Tilemap rendering ─────────────────────────────────────────────────────── */

/* Write one virtual row directly into the tilemap at its ring-buffer row.
   vrow is a virtual index: 0..GBS_NUM_TRACKS-1 = track,
   GBS_NUM_TRACKS..TOTAL_ITEMS-1 = blank (bottom padding).
   Caller must ensure VRAM is accessible (LCD disabled).
   Used only by bulk_render() during init / large jumps. */
static void render_track_row(uint8_t vrow) {
    uint8_t tmap_row = vrow & 31u;
    volatile uint8_t *tmap = (volatile uint8_t*)(0x9800u + (uint16_t)tmap_row * 32u);
    const char *title;
    uint8_t col, ch;
    uint8_t track_idx;

    if (vrow >= (uint8_t)(LIST_PAD_TOP + GBS_NUM_TRACKS)) {
        for (col = 0u; col < 20u; col++) tmap[col] = SOFT_FONT_BASE;
        s_row_content[tmap_row] = vrow;
        return;
    }

    track_idx = vrow - LIST_PAD_TOP;
    load_track_title(track_idx, s_title_buf);
    title = s_title_buf;
    tmap[0] = 0u;

    for (col = 1u; col < 20u; col++) {
        ch = (uint8_t)*title;
        if (ch == 0u) {
            while (col < 20u) { tmap[col++] = SOFT_FONT_BASE; }
            break;
        }
        if (col == 19u && title[1] != 0u) { tmap[19] = TILE_ELLIPSIS; break; }
        if (ch < 0x20u || ch > 0x7Eu) ch = (uint8_t)'?';
        tmap[col] = (uint8_t)(SOFT_FONT_BASE + (ch - 0x20u));
        title++;
    }

    s_row_content[tmap_row] = vrow;
}

/* Bulk-render every dirty track in [need_min, need_max].
   Disables the LCD for the duration — use only at init or for large jumps. */
static void bulk_render(uint8_t need_min, uint8_t need_max) {
    uint8_t i;
    uint8_t dirty = 0u;

    for (i = need_min; i <= need_max; i++) {
        if (s_row_content[i & 31u] != i) { dirty = 1u; break; }
    }
    if (!dirty) return;

    *LCDC_REG = 0x00u;
    for (i = need_min; i <= need_max; i++) {
        if (s_row_content[i & 31u] != i) render_track_row(i);
    }
    *BGP_REG  = 0xE4u;
    *LCDC_REG = 0xF3u;
}

/* Stage one virtual row's tile indices into s_row_buf (WRAM only, no VRAM access).
   Called from ui_prepare() outside VBlank — no timing constraint. */
static void stage_track_row(uint8_t vrow) {
    const char *title;
    uint8_t col, ch;
    uint8_t track_idx;

    if (vrow >= (uint8_t)(LIST_PAD_TOP + GBS_NUM_TRACKS)) {
        for (col = 0u; col < 20u; col++) s_row_buf[col] = SOFT_FONT_BASE;
        s_pending_row = vrow;
        return;
    }

    track_idx = vrow - LIST_PAD_TOP;
    load_track_title(track_idx, s_title_buf);
    title = s_title_buf;
    s_row_buf[0] = 0u;

    for (col = 1u; col < 20u; col++) {
        ch = (uint8_t)*title;
        if (ch == 0u) {
            while (col < 20u) { s_row_buf[col++] = SOFT_FONT_BASE; }
            break;
        }
        if (col == 19u && title[1] != 0u) { s_row_buf[19] = TILE_ELLIPSIS; break; }
        if (ch < 0x20u || ch > 0x7Eu) ch = (uint8_t)'?';
        s_row_buf[col] = (uint8_t)(SOFT_FONT_BASE + (ch - 0x20u));
        title++;
    }

    s_pending_row = vrow;
}

/* Copy the staged buffer to VRAM and update the ring-buffer cache.
   Called at the very start of VBlank — 20 byte writes ~ 100 cycles. */
static void flush_pending(void) {
    uint8_t tmap_row;
    volatile uint8_t *tmap;
    uint8_t col;

    if (s_pending_row == 0xFFu) return;

    tmap_row = s_pending_row & 31u;
    tmap = (volatile uint8_t*)(0x9800u + (uint16_t)tmap_row * 32u);
    for (col = 0u; col < 20u; col++) {
        tmap[col] = s_row_buf[col];
    }
    s_row_content[tmap_row] = s_pending_row;
    s_pending_row = 0xFFu;
}

/* ── Now-playing name (condensed font, scratch tiles on window layer) ─────── */

/* Blit a string proportionally into scratch tiles starting at pixel_x.
   scratch_base is the first tile index of the scratch region.
   Returns the pixel X position after the last character drawn.
   Glyph bits are OR-ed into VRAM, so the scratch region must be zeroed first.
   LCD must be disabled by the caller.
   Reads glyph pixel data directly from VRAM (condensed font at 0x8000,
   already loaded by reload_tiles) and widths from s_font_widths (WRAM).
   No bank switching is needed. */
static uint8_t blit_string(uint8_t pixel_x, const char *s, uint8_t scratch_base) {
    /* Condensed font tiles at VRAM 0x8000 — LCD is off so VRAM is readable. */
    const volatile uint8_t *fdata = (const volatile uint8_t*)0x8000u;
    char ch;
    while ((ch = *s++) != '\0') {
        uint8_t glyph, w, tcol, shift, row;
        uint16_t glyph_base, tile_addr;
        volatile uint8_t *dst;

        if ((uint8_t)ch < 0x20u || (uint8_t)ch > 0x7Eu) ch = ' ';
        glyph = (uint8_t)ch - 0x20u;
        w = s_font_widths[glyph];

        if ((uint16_t)pixel_x + w > 120u) break;

        tcol  = pixel_x >> 3u;
        shift = pixel_x & 7u;
        glyph_base = (uint16_t)glyph << 4u;

        for (row = 0u; row < 8u; row++) {
            uint8_t lo = fdata[glyph_base + (row << 1u)];
            uint8_t hi = fdata[glyph_base + (row << 1u) + 1u];

            tile_addr = 0x8000u +
                        (((uint16_t)scratch_base + tcol) << 4u) +
                        (row << 1u);
            dst = (volatile uint8_t*)tile_addr;

            dst[0] |= lo >> shift;
            dst[1] |= hi >> shift;

            if (shift != 0u && tcol < 15u) {
                volatile uint8_t *spill = dst + 16u;
                spill[0] |= lo << (8u - shift);
                spill[1] |= hi << (8u - shift);
            }
        }

        pixel_x += w;
    }
    return pixel_x;
}

/* Clear the 16 name scratch tiles and blit the track name left-aligned.
   Disables LCD for the duration.  Called only on track changes.
   Font tile data in VRAM is NOT reloaded — it was loaded once in ui_init
   and does not change (only scratch tiles are rewritten here). */
static void draw_name(uint8_t track) {
    volatile uint8_t *p;
    uint8_t t, b;

    *LCDC_REG = 0x00u;

    /* Zero all 16 scratch tiles (256 bytes). */
    p = SCRATCH_NAME_VRAM;
    for (t = 0u; t < 16u; t++) {
        for (b = 0u; b < 16u; b++) *p++ = 0u;
    }

    if (track >= 1u && track <= GBS_NUM_TRACKS) {
        load_track_title(track - 1u, s_title_buf);
        blit_string(3u, s_title_buf, SCRATCH_NAME_BASE);
    }

    s_name_track = track;

    *BGP_REG  = 0xE4u;
    *LCDC_REG = 0xF3u;
}

/* ── Sprite update ─────────────────────────────────────────────────────────── */

static void update_sprites(void) {
    uint8_t playing;
    uint8_t playing_vpos;
    uint8_t cursor_vpos;
    uint8_t y;
    uint8_t i;

    for (i = 0u; i < 16u; i++) OAM[i] = 0u;

    /* Sprites must stay above the bottom window overlay (LY 112+).
       OAM Y <= 120 keeps 8x8 sprites fully above LY 112. */

    cursor_vpos = s_cursor + LIST_PAD_TOP;
    y = (uint8_t)((uint8_t)((uint8_t)(cursor_vpos & 31u) * 8u) - s_scy) + 16u;
    if (y > 0u && y <= 120u) {
        OAM[0] = y;
        OAM[1] = SPRITE_X;
        OAM[2] = TILE_CURSOR;
    }

    playing = player_get_current_track();
    if (playing > 0u) {
        playing_vpos = (playing - 1u) + LIST_PAD_TOP;
        if (playing_vpos >= s_scroll_top
                && playing_vpos < (uint8_t)(s_scroll_top + N_ROWS)
                && playing_vpos != cursor_vpos) {
            y = (uint8_t)((uint8_t)((uint8_t)(playing_vpos & 31u) * 8u) - s_scy) + 16u;
            if (y > 0u && y <= 120u) {
                OAM[4] = y;
                OAM[5] = SPRITE_X;
                OAM[6] = TILE_PLAYING;
            }
        }
    }
}

/* ── SCY animation ─────────────────────────────────────────────────────────── */

static void animate_scy(void) {
    int8_t delta;
    if (s_scy == s_target_scy) return;
    delta = (int8_t)((uint8_t)(s_target_scy - s_scy));
    if (delta >= (int8_t)SCROLL_SPEED) {
        s_scy = (uint8_t)(s_scy + SCROLL_SPEED);
    } else if (delta <= -(int8_t)SCROLL_SPEED) {
        s_scy = (uint8_t)(s_scy - SCROLL_SPEED);
    } else {
        s_scy = s_target_scy;
    }
}

/* ── Public API ────────────────────────────────────────────────────────────── */

void ui_init(void) {
    uint8_t first = (uint8_t)(GBS_FIRST_TRACK - 1u);
    uint8_t need_max;
    uint8_t i;

    for (i = 0u; i < 32u; i++) s_row_content[i] = 0xFFu;
    for (i = 0u; i < 160u; i++) OAM[i] = 0u;

    s_cursor      = first;
    s_scroll_top  = desired_scroll_top(first);
    s_target_scy  = (uint8_t)((uint16_t)s_scroll_top * 8u);
    s_scy         = s_target_scy;
    s_last_scroll = s_scroll_top;
    s_pending_row = 0xFFu;
    s_name_track  = 0u;

    /* Load all tile data from the resource bank into VRAM (one-time).
       This is the only place reload_tiles() is called — font/icon/cover
       tile data does not change after this point. */
    *LCDC_REG = 0x00u;
    reload_tiles();
#if !BANKED_CODE
    /* In non-banked mode, restore bank 1 for GBS driver.
       In banked mode, banked_copy() already restores the code bank. */
    MBC_BANK_REG = 1u;
#endif
    *LCDC_REG = 0xF3u;

    need_max = (uint8_t)(s_scroll_top + TMAP_ROWS - 1u);
    if (need_max >= TOTAL_ITEMS || need_max < s_scroll_top)
        need_max = (uint8_t)(TOTAL_ITEMS - 1u);
    bulk_render(s_scroll_top, need_max);

    /* Set up window tilemap rows (LCD still off from bulk_render). */
    *LCDC_REG = 0x00u;

    /* Row 0: border tile across full width. */
    for (i = 0u; i < 20u; i++) WIN_BORDER_ROW[i] = TILE_BORDER;

    /* Row 1: blank + cover top + blank + album icon + title scratch tiles.
       Col 0: blank, Col 1-2: cover TL/TR, Col 3: blank, Col 4: album icon,
       Col 5-19: scratch tiles (15 tiles). */
    WIN_TITLE_ROW[0] = 0u;
    WIN_TITLE_ROW[1] = COVER_TILE_TL;
    WIN_TITLE_ROW[2] = COVER_TILE_TR;
    WIN_TITLE_ROW[3] = 0u;
    WIN_TITLE_ROW[4] = ICON_ALBUM_TILE;
    for (i = 5u; i < 20u; i++) {
        WIN_TITLE_ROW[i] = SCRATCH_TITLE_BASE + (i - 5u);
    }

    /* Row 2: blank + cover bottom + blank + track icon + name scratch tiles.
       Col 0: blank, Col 1-2: cover BL/BR, Col 3: blank, Col 4: track icon,
       Col 5-19: scratch tiles (15 tiles). */
    WIN_NAME_ROW[0] = 0u;
    WIN_NAME_ROW[1] = COVER_TILE_BL;
    WIN_NAME_ROW[2] = COVER_TILE_BR;
    WIN_NAME_ROW[3] = 0u;
    WIN_NAME_ROW[4] = ICON_TRACK_TILE;
    for (i = 5u; i < 20u; i++) {
        WIN_NAME_ROW[i] = SCRATCH_NAME_BASE + (i - 5u);
    }

    /* Zero and blit the album title into its scratch tiles (LCD still off).
       Font data is already in VRAM from reload_tiles — no bank switching needed. */
    {
        volatile uint8_t *p = SCRATCH_TITLE_VRAM;
        uint8_t t, b;
        for (t = 0u; t < 16u; t++)
            for (b = 0u; b < 16u; b++) *p++ = 0u;
        blit_string(3u, ALBUM_TITLE, SCRATCH_TITLE_BASE);
    }

    *LCDC_REG = 0xF3u;

    /* Blit the initial track name. */
    draw_name(player_get_current_track());

    update_sprites();
    *SCY_REG = s_scy;
}

void ui_update(void) {
    uint8_t playing;

    /* All VBlank work — fast VRAM copy + OAM + registers. */
    flush_pending();
    animate_scy();
    update_sprites();
    *SCY_REG = s_scy;

    /* If the playing track changed, reblit the name scratch tiles.
       draw_name() disables LCD (~320 byte clear + blit), so it causes
       a brief blank — acceptable since track changes also have an
       audio gap from GBS INIT. */
    playing = player_get_current_track();
    if (playing != s_name_track) {
        draw_name(playing);
    }
}

void ui_prepare(void) {
    /* Called OUTSIDE VBlank — pre-compute tile indices into WRAM buffer.
       String processing + ROM reads have no timing constraint here. */
    uint8_t new_row;
    if (s_scroll_top == s_last_scroll) return;

    if (s_scroll_top > s_last_scroll) {
        new_row = (uint8_t)(s_scroll_top + N_ROWS - 1u);
    } else {
        new_row = s_scroll_top;
    }
    s_last_scroll = s_scroll_top;

    if (new_row < TOTAL_ITEMS && s_row_content[new_row & 31u] != new_row) {
        stage_track_row(new_row);
    }
}

uint8_t ui_get_scy(void) { return s_scy; }

void ui_cursor_up(void) {
    if (s_cursor == 0u) return;
    s_cursor--;
    s_scroll_top = desired_scroll_top(s_cursor);
    s_target_scy = (uint8_t)((uint16_t)s_scroll_top * 8u);
}

void ui_cursor_down(void) {
    if (s_cursor >= (uint8_t)(GBS_NUM_TRACKS - 1u)) return;
    s_cursor++;
    s_scroll_top = desired_scroll_top(s_cursor);
    s_target_scy = (uint8_t)((uint16_t)s_scroll_top * 8u);
}

void ui_cursor_set(uint8_t idx) {
    uint8_t need_max;
    if (idx >= (uint8_t)GBS_NUM_TRACKS) idx = (uint8_t)(GBS_NUM_TRACKS - 1u);
    s_cursor     = idx;
    s_scroll_top = desired_scroll_top(idx);
    s_target_scy = (uint8_t)((uint16_t)s_scroll_top * 8u);
    s_scy        = s_target_scy;
    need_max = (uint8_t)(s_scroll_top + TMAP_ROWS - 1u);
    if (need_max >= TOTAL_ITEMS || need_max < s_scroll_top)
        need_max = (uint8_t)(TOTAL_ITEMS - 1u);
    bulk_render(s_scroll_top, need_max);
    s_last_scroll = s_scroll_top;
}

uint8_t ui_cursor_get(void) { return s_cursor; }
