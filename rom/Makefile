# ── Game Boy ROM build ──────────────────────────────────────────────
#
# Prerequisites:
#   - GBDK-2020: https://github.com/gbdk-2020/gbdk-2020/releases
#   - Set GBDK_HOME to the GBDK-2020 installation directory, e.g.:
#       export GBDK_HOME=/opt/gbdk-2020   (Linux/macOS)
#       set GBDK_HOME=C:\gbdk-2020        (Windows)
#
# Usage:
#   make            — build the ROM
#   make clean      — remove build output
#
# Note: You normally don't invoke this Makefile directly — the TypeScript build
# tool calls it for you via `build:rom`. The generated/ directory must
# exist (it is created by the build tool before compiling).
# ─────────────────────────────────────────────────────────────────────────────

GBDK_HOME ?= $(HOME)/gbdk-2020

ifeq ($(OS),Windows_NT)
    CC = "$(GBDK_HOME)/bin/lcc.exe"
else
    CC = $(GBDK_HOME)/bin/lcc
endif

# -Wl-m  : produce a map file (useful for debugging — shows where symbols landed)
# -Wl-j  : no save/restore of registers in interrupt handlers (we manage this)
CFLAGS = -Wl-m -Wl-j

ROM     = build/player.gb
SRCS    = src/main.c        \
          src/ui.c          \
          src/input.c       \
          src/player.c      \
          src/generated/playlist_data.c

.PHONY: all clean

all: build $(ROM)

build:
	mkdir -p build
	mkdir -p src/generated

$(ROM): $(SRCS)
	$(CC) $(CFLAGS) -o $(ROM) $(SRCS)

clean:
	rm -rf build
