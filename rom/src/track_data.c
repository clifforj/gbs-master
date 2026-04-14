/* track_data.c — WRAM-backed track metadata cache.
 *
 * See track_data.h for rationale.  Summary: mid-runtime bank switching
 * breaks some GBS drivers, so we copy every 32-byte track entry into
 * a WRAM cache once during startup and read from there thereafter.
 *
 * The cache is split across a variable number of non-contiguous WRAM
 * regions (as many as needed to fit the track count into the free WRAM
 * the build tool found).  Region descriptors live in the config table
 * as a {addr, capacity} list terminated by capacity==0. */

#include <stdint.h>
#include "hardware.h"
#include "config.h"
#include "resource_bank.h"
#include "track_data.h"

#define RES_ENTRY_SIZE 32u

static uint8_t *entry_addr(uint8_t idx) {
    const uint8_t *p = (const uint8_t*)(CONFIG_BASE + CFG_OFF_CACHE_TABLE);
    /* The build tool clamps GBS_NUM_TRACKS to the total cache capacity, so
     * idx is guaranteed to land in one of the populated regions before the
     * capacity==0 terminator. */
    while (idx >= p[2]) {
        idx -= p[2];
        p += CFG_CACHE_REGION_SIZE;
    }
    uint16_t addr = (uint16_t)p[0] | ((uint16_t)p[1] << 8);
    return (uint8_t*)addr + ((uint16_t)idx * TRACK_CACHE_ENTRY_SIZE);
}

static uint8_t effective_count(void) {
    uint8_t n = GBS_NUM_TRACKS;
    if (n > TRACK_CACHE_MAX_TRACKS) n = TRACK_CACHE_MAX_TRACKS;
    return n;
}

static void copy_entry(const uint8_t *src, uint8_t *dst) {
    uint8_t i;
    for (i = 0u; i < RES_ENTRY_SIZE; i++) dst[i] = src[i];
}

void track_data_init(void) {
    uint8_t n = effective_count();
    uint8_t i;

#if BANKED_CODE
    for (i = 0u; i < n; i++) {
        uint8_t raw[RES_ENTRY_SIZE];
        bcopy_params.bank = RESOURCE_BANK_NUM;
        bcopy_params.src  = RES_TRACK_DATA + ((uint16_t)i * RES_ENTRY_SIZE);
        bcopy_params.dst  = raw;
        bcopy_params.len  = RES_ENTRY_SIZE;
        banked_copy();
        copy_entry(raw, entry_addr(i));
    }
#else
    MBC_BANK_REG = RESOURCE_BANK_NUM;
    for (i = 0u; i < n; i++) {
        const uint8_t *src = RES_TRACK_DATA + ((uint16_t)i * RES_ENTRY_SIZE);
        copy_entry(src, entry_addr(i));
    }
    MBC_BANK_REG = 1u;
#endif
}

void load_track_title(uint8_t idx, char *buf) {
    const uint8_t *entry = entry_addr(idx);
    uint8_t i;
    for (i = 0u; i < TRACK_CACHE_TITLE_MAX; i++) {
        buf[i] = (char)entry[1u + i];
        if (entry[1u + i] == 0u) return;
    }
    buf[TRACK_CACHE_TITLE_MAX - 1u] = 0;
}

uint8_t get_gbs_track_number(uint8_t idx) {
    return entry_addr(idx)[0];
}
