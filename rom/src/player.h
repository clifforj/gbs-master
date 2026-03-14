#ifndef PLAYER_H
#define PLAYER_H

#include <stdint.h>

void player_init(void);
void player_tick(void);
void player_set_track(uint8_t track_number);
void player_next_track(void);
void player_prev_track(void);
uint8_t player_get_current_track(void);

#endif /* PLAYER_H */
