/* hardware.h — Game Boy hardware register definitions.
 * Consolidates register addresses and common values used across the ROM. */

#ifndef HARDWARE_H
#define HARDWARE_H

#include <stdint.h>

/* ── LCD registers ──────────────────────────────────────────────────────── */
#define LCDC_REG  ((volatile uint8_t*)0xFF40)
#define STAT_REG  ((volatile uint8_t*)0xFF41)
#define SCY_REG   ((volatile uint8_t*)0xFF42)
#define SCX_REG   ((volatile uint8_t*)0xFF43)
#define LY_REG    (*(volatile uint8_t*)0xFF44)
#define BGP_REG   ((volatile uint8_t*)0xFF47)
#define OBP0_REG  ((volatile uint8_t*)0xFF48)
#define WY_REG    ((volatile uint8_t*)0xFF4A)
#define WX_REG    ((volatile uint8_t*)0xFF4B)

/* ── Sound registers ────────────────────────────────────────────────────── */
#define NR50_REG  (*(volatile uint8_t*)0xFF24)
#define NR51_REG  (*(volatile uint8_t*)0xFF25)
#define NR52_REG  (*(volatile uint8_t*)0xFF26)

/* ── Joypad ─────────────────────────────────────────────────────────────── */
#define P1_REG    (*(volatile uint8_t*)0xFF00)

/* ── Interrupt registers ────────────────────────────────────────────────── */
#define IE_REG    (*(volatile uint8_t*)0xFFFF)

/* ── MBC1 ───────────────────────────────────────────────────────────────── */
#define MBC_BANK_REG  (*(volatile uint8_t*)0x2000u)

/* ── OAM ────────────────────────────────────────────────────────────────── */
#define OAM       ((volatile uint8_t*)0xFE00u)

/* ── HRAM flags ─────────────────────────────────────────────────────────── */
#define VBL_FLAG  (*(volatile uint8_t*)0xFF80)

/* ── Common register values ─────────────────────────────────────────────── */
#define LCDC_ON_BG     0x91u  /* LCD on, BG on, tiles at 0x8000 */
#define LCDC_ON_WIN    0xF3u  /* LCD on, window on, OBJ on, BG on */
#define LCDC_OFF       0x00u  /* LCD off */
#define BGP_DEFAULT    0xE4u  /* 00=white, 01=lgray, 10=dgray, 11=black */
#define IE_VBL_ONLY    0x01u  /* VBlank interrupt only */

#endif /* HARDWARE_H */
