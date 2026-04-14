import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { generateConfig, generateTrampolines, buildTrackData } from "./codegen.js";
import type { ParsedGbs } from "../gbs/types.js";
import type { Track } from "../playlist/types.js";
import { readFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function mockGbs(): ParsedGbs {
  return {
    header: {
      magic: "GBS",
      version: 1,
      numSongs: 3,
      firstSong: 1,
      loadAddr: 0x3F56,
      initAddr: 0x3F56,
      playAddr: 0x3F7E,
      stackPtr: 0xDFFF,
      timerModulo: 0,
      timerControl: 0,
      title: "Test Game",
      author: "Test Author",
      copyright: "2024",
    },
    raw: Buffer.alloc(0x70),
    gbsRomOffset: 0x3EE6,
    usesTimerInterrupt: false,
  };
}

function makeTracks(): Track[] {
  return [
    { number: 1, title: "Opening" },
    { number: 2, title: "Battle Theme" },
    { number: 3, title: "Ending" },
  ];
}

describe("generateConfig", () => {
  it("writes config.s with expected GBS addresses and metadata", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codegen-test-"));
    const gbs = mockGbs();
    const tracks = makeTracks();

    await generateConfig(gbs, tracks, dir, { resourceBank: 5 });

    const config = readFileSync(join(dir, "config.s"), "utf8");

    // Check GBS addresses (little-endian .dw)
    assert.ok(config.includes("0x3F56"), "config should contain initAddr");
    assert.ok(config.includes("0x3F7E"), "config should contain playAddr");
    assert.ok(config.includes("0xDFFF"), "config should contain stackPtr");
    // Check num_tracks
    assert.ok(config.includes(".db #3"), "config should contain num_tracks = 3");
    // Check resource bank
    assert.ok(config.includes(".db #5"), "config should contain resource_bank = 5");
    // Check album metadata
    assert.ok(config.includes("Test Game"), "config should contain album title");
    assert.ok(config.includes("Test Author"), "config should contain album author");
  });

  it("replaces non-ASCII characters with '?' in album metadata", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codegen-ascii-"));
    const gbs = mockGbs();
    gbs.header.title = "Caf\u00e9 Music";
    const tracks: Track[] = [{ number: 1, title: "Pok\u00e9mon" }];

    await generateConfig(gbs, tracks, dir);
    const config = readFileSync(join(dir, "config.s"), "utf8");

    assert.ok(config.includes("Caf? Music"), "non-ASCII in album title replaced with ?");
  });

  it("uses custom WRAM stack address when provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codegen-wram-"));
    const gbs = mockGbs();
    const tracks = makeTracks();

    await generateConfig(gbs, tracks, dir, {
      wram: {
        dataAddr: 0xC500,
        initializedAddr: 0xC5A0,
        stackAddr: 0xC800,
        cacheRegions: [{ addr: 0xC900, capacity: 96 }],
        cacheTotalCapacity: 96,
      },
    });

    const config = readFileSync(join(dir, "config.s"), "utf8");
    assert.ok(config.includes("0xC800"), "config should contain player_stack_ptr = 0xC800");
  });

  it("uses playlist title override when provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codegen-title-"));
    const gbs = mockGbs();
    const tracks = makeTracks();

    await generateConfig(gbs, tracks, dir, { title: "Custom Album" });

    const config = readFileSync(join(dir, "config.s"), "utf8");
    assert.ok(config.includes("Custom Album"), "config should contain custom album title");
  });
});

describe("generateTrampolines", () => {
  it("non-banked mode provides init and play trampoline symbols", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tramp-simple-"));

    await generateTrampolines(dir, { enabled: false, codeBankNum: 0 }, 0x3F56, 0x3F7E);

    const asm = readFileSync(join(dir, "trampolines.s"), "utf8");
    assert.ok(asm.includes("_gbs_init_trampoline::"), "should have init trampoline");
    assert.ok(asm.includes("_gbs_play_trampoline::"), "should have play trampoline");
    assert.ok(asm.includes("_entry::"), "should have entry point");
    assert.ok(asm.includes("0x3F56"), "should contain initAddr");
    assert.ok(asm.includes("0x3F7E"), "should contain playAddr");
  });

  it("banked mode includes bank switching and banked_copy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tramp-banked-"));

    await generateTrampolines(dir, { enabled: true, codeBankNum: 4 }, 0x3F00, 0x3F20);

    const asm = readFileSync(join(dir, "trampolines.s"), "utf8");
    assert.ok(asm.includes("_gbs_init_trampoline::"), "should have init trampoline");
    assert.ok(asm.includes("_gbs_play_trampoline::"), "should have play trampoline");
    assert.ok(asm.includes("_banked_copy::"), "should have banked_copy");
    assert.ok(asm.includes("ld   a, #4"), "should restore code bank 4");
    assert.ok(asm.includes("0x3F00"), "should contain initAddr");
    assert.ok(asm.includes("0x3F20"), "should contain playAddr");
  });
});

describe("buildTrackData", () => {
  it("builds 32-byte entries with gbs_track and null-terminated title", () => {
    const tracks: Track[] = [
      { number: 5, title: "Opening" },
      { number: 3, title: "Battle" },
    ];

    const data = buildTrackData(tracks);
    assert.equal(data.length, 64, "2 tracks * 32 bytes each");

    // Track 0: gbs_track = 5
    assert.equal(data[0], 5);
    // Track 0: title starts at offset 1
    assert.equal(String.fromCharCode(data[1], data[2], data[3], data[4], data[5], data[6], data[7]),
      "Opening");
    // Track 0: null terminator after title
    assert.equal(data[8], 0);

    // Track 1: gbs_track = 3, starts at offset 32
    assert.equal(data[32], 3);
    assert.equal(String.fromCharCode(data[33], data[34], data[35], data[36], data[37], data[38]),
      "Battle");
  });

  it("truncates long titles and ensures null termination", () => {
    const longTitle = "A".repeat(50);
    const tracks: Track[] = [{ number: 1, title: longTitle }];

    const data = buildTrackData(tracks);
    assert.equal(data.length, 32);
    // Title field is 31 bytes (offset 1-31), last byte should be 0
    assert.equal(data[31], 0, "last byte of entry should be null");
    // Title should be truncated to 30 chars
    let titleLen = 0;
    for (let i = 1; i < 32; i++) {
      if (data[i] === 0) break;
      titleLen++;
    }
    assert.ok(titleLen <= 30, "title should be truncated");
  });
});
