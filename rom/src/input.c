#include <stdint.h>
#include "hardware.h"
#include "input.h"

static uint8_t s_prev_keys = 0;
static uint8_t s_curr_keys = 0;

static uint8_t read_joypad(void) {
    uint8_t dir, btn;
    P1_REG = 0x20u;         /* select direction buttons (bit 5 low) */
    /* Settling delay — multiplexer needs a few cycles after P1 write.
       Each volatile read is one LDH instruction (~3 cycles). */
    (void)P1_REG;
    (void)P1_REG;
    dir = P1_REG & 0x0Fu;   /* read lower nibble (active low) */
    P1_REG = 0x10u;         /* select action buttons (bit 4 low) */
    (void)P1_REG;
    (void)P1_REG;
    btn = P1_REG & 0x0Fu;   /* read lower nibble (active low) */
    P1_REG = 0x30u;         /* deselect all */
    /* Invert active-low, pack: direction in bits 0-3, action in bits 4-7 */
    return (uint8_t)(~((btn << 4) | dir) & 0xFFu);
}

void input_init(void) {
    s_prev_keys = 0;
    s_curr_keys = 0;
}

void input_update(void) {
    s_prev_keys = s_curr_keys;
    s_curr_keys = read_joypad();
}

uint8_t input_pressed(uint8_t buttons) {
    return (s_curr_keys & buttons) & ~(s_prev_keys & buttons);
}
