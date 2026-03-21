/* track_data.c — Read track metadata from the resource bank.
 *
 * Track data is appended after cover tiles in the resource bank.
 * Each entry is 32 bytes: [gbs_track:u8][title:char[31]].
 *
 * In non-banked mode: direct MBC bank switch, read, restore bank 1.
 * In banked mode: uses the bank-0 banked_copy() helper since switching
 * the MBC bank would unmap the code we are executing from. */

#include <stdint.h>
#include "hardware.h"
#include "config.h"
#include "resource_bank.h"
#include "track_data.h"

void load_track_title(uint8_t idx, char *buf) {
    uint16_t entry_off = (uint16_t)idx << 5u;  /* idx * 32 */

#if BANKED_CODE
    bcopy_params.bank = RESOURCE_BANK_NUM;
    bcopy_params.src  = RES_TRACK_DATA + entry_off + 1u;
    bcopy_params.dst  = (uint8_t*)buf;
    bcopy_params.len  = 31u;
    banked_copy();
#else
    {
        const uint8_t *src;
        uint8_t i;
        MBC_BANK_REG = RESOURCE_BANK_NUM;
        src = RES_TRACK_DATA + entry_off + 1u;
        for (i = 0u; i < 31u; i++) buf[i] = src[i];
        MBC_BANK_REG = 1u;
    }
#endif
}

uint8_t get_gbs_track_number(uint8_t idx) {
    uint8_t result;
    uint16_t entry_off = (uint16_t)idx << 5u;  /* idx * 32 */

#if BANKED_CODE
    bcopy_params.bank = RESOURCE_BANK_NUM;
    bcopy_params.src  = RES_TRACK_DATA + entry_off;
    bcopy_params.dst  = &result;
    bcopy_params.len  = 1u;
    banked_copy();
#else
    MBC_BANK_REG = RESOURCE_BANK_NUM;
    result = *(RES_TRACK_DATA + entry_off);
    MBC_BANK_REG = 1u;
#endif

    return result;
}
