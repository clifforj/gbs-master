#ifndef INPUT_H
#define INPUT_H

#include <stdint.h>

/* Joypad button bitmasks — same layout as GBDK's J_* constants.
   Direction nibble (bits 0-3): active when direction pad pressed.
   Button nibble (bits 4-7): active when action button pressed. */
#define J_RIGHT   0x01u
#define J_LEFT    0x02u
#define J_UP      0x04u
#define J_DOWN    0x08u
#define J_A       0x10u
#define J_B       0x20u
#define J_SELECT  0x40u
#define J_START   0x80u

void input_init(void);
void input_update(void);
uint8_t input_pressed(uint8_t buttons);

#endif /* INPUT_H */
