/* config.h — Runtime configuration table in ROM bank 0 at 0x0280.
 *
 * Values are populated by the build tool (config.s generation) for CLI builds,
 * or binary-patched by the web app for template-based builds.
 * All reads are from the fixed ROM bank (0x0000-0x3FFF), always accessible
 * regardless of which switchable bank is selected. */

#ifndef CONFIG_H
#define CONFIG_H

#include <stdint.h>

#define CONFIG_BASE 0x0280u

/* Read a uint8 / uint16 from the config table at the given byte offset. */
#define CFG_U8(off)  (*(const volatile uint8_t*)(CONFIG_BASE + (off)))
#define CFG_U16(off) (*(const volatile uint16_t*)(CONFIG_BASE + (off)))

/* ── Config table field offsets (see config.s for full layout) ────────────── */
#define CFG_OFF_GBS_INIT_ADDR    0x00  /* uint16 LE */
#define CFG_OFF_GBS_PLAY_ADDR    0x02  /* uint16 LE */
#define CFG_OFF_GBS_STACK_PTR    0x04  /* uint16 LE */
#define CFG_OFF_TIMER_MODULO     0x06  /* uint8 */
#define CFG_OFF_TIMER_CONTROL    0x07  /* uint8 */
#define CFG_OFF_USE_TIMER        0x08  /* uint8 (0 or 1) */
#define CFG_OFF_NUM_TRACKS       0x09  /* uint8 */
#define CFG_OFF_RESOURCE_BANK    0x0A  /* uint8 */
#define CFG_OFF_PLAYER_STACK_PTR 0x0B  /* uint16 LE */
#define CFG_OFF_ALBUM_TITLE      0x0D  /* char[31] null-terminated */
#define CFG_OFF_ALBUM_AUTHOR     0x2C  /* char[31] null-terminated */
#define CFG_OFF_ALBUM_COPYRIGHT  0x4B  /* char[31] null-terminated */
/* Variable-length cache region table.  Each entry is 3 bytes:
 *   +0: addr (uint16 LE)   +2: capacity (uint8, # of 32-byte entries)
 * The list is terminated by an entry with capacity == 0.  The build tool
 * emits as many entries as the WRAM layout requires, packed in iteration
 * order — entries [0 .. caps[0]) live in region 0, etc. */
#define CFG_OFF_CACHE_TABLE      0x6A
#define CFG_CACHE_REGION_SIZE    3u

/* ── Convenient runtime accessors ────────────────────────────────────────── */
#define GBS_NUM_TRACKS    CFG_U8(CFG_OFF_NUM_TRACKS)
#define GBS_FIRST_TRACK   1u
#define RESOURCE_BANK_NUM CFG_U8(CFG_OFF_RESOURCE_BANK)
#define ALBUM_TITLE       ((const char*)(CONFIG_BASE + CFG_OFF_ALBUM_TITLE))
#define ALBUM_AUTHOR      ((const char*)(CONFIG_BASE + CFG_OFF_ALBUM_AUTHOR))
#define ALBUM_COPYRIGHT   ((const char*)(CONFIG_BASE + CFG_OFF_ALBUM_COPYRIGHT))

/* ── Banked copy support (used by ui.c and track_data.c in banked mode) ──── */
#if BANKED_CODE
typedef struct {
    uint8_t        bank;
    const uint8_t *src;
    uint8_t       *dst;
    uint16_t       len;
} BankedCopyParams;
extern BankedCopyParams bcopy_params;
extern void banked_copy(void);
#endif

#endif /* CONFIG_H */
