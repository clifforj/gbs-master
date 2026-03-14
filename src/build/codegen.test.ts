import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { generateCode } from "./codegen.js";
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

describe("generateCode", () => {
  it("writes header and source files with expected #define values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codegen-test-"));
    const gbs = mockGbs();
    const tracks = makeTracks();

    await generateCode(gbs, tracks, dir);

    const header = readFileSync(join(dir, "playlist_data.h"), "utf8");
    const source = readFileSync(join(dir, "playlist_data.c"), "utf8");

    // Check header defines
    assert.ok(header.includes("#define GBS_INIT_ADDR   0x3F56"));
    assert.ok(header.includes("#define GBS_PLAY_ADDR   0x3F7E"));
    assert.ok(header.includes("#define GBS_STACK_PTR   0xDFFF"));
    assert.ok(header.includes("#define GBS_NUM_TRACKS   3U"));
    assert.ok(header.includes('#define ALBUM_TITLE     "Test Game"'));
    assert.ok(header.includes('#define ALBUM_AUTHOR    "Test Author"'));

    // Check source has track entries
    assert.ok(source.includes('"Opening"'));
    assert.ok(source.includes('"Battle Theme"'));
    assert.ok(source.includes('"Ending"'));
  });

  it("escapes quotes and backslashes in track titles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codegen-escape-"));
    const gbs = mockGbs();
    const tracks: Track[] = [
      { number: 1, title: 'He said "hello"' },
      { number: 2, title: "back\\slash" },
    ];

    await generateCode(gbs, tracks, dir);
    const source = readFileSync(join(dir, "playlist_data.c"), "utf8");

    assert.ok(source.includes('He said \\"hello\\"'), "quotes should be escaped");
    assert.ok(source.includes("back\\\\slash"), "backslashes should be escaped");
  });

  it("replaces non-ASCII characters with '?'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codegen-ascii-"));
    const gbs = mockGbs();
    gbs.header.title = "Caf\u00e9 Music";
    const tracks: Track[] = [{ number: 1, title: "Pok\u00e9mon" }];

    await generateCode(gbs, tracks, dir);
    const header = readFileSync(join(dir, "playlist_data.h"), "utf8");
    const source = readFileSync(join(dir, "playlist_data.c"), "utf8");

    assert.ok(header.includes("Caf? Music"), "non-ASCII in album title replaced with ?");
    // Track titles go through escapeC() not toAscii(), so non-ASCII bytes
    // are preserved in the C source (the GB font won't render them, but
    // the C compiler accepts them in string literals).
    assert.ok(source.includes("Pok\u00e9mon") || source.includes("Pok?mon"),
      "track title present in source");
  });

  it("generates BANKED_CODE 1 when banked code mode is enabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codegen-banked-"));
    const gbs = mockGbs();
    const tracks = makeTracks();

    await generateCode(gbs, tracks, dir, {
      bankedCode: { enabled: true, codeBankNum: 4 },
    });

    const header = readFileSync(join(dir, "playlist_data.h"), "utf8");
    assert.ok(header.includes("#define BANKED_CODE        1"));
    assert.ok(header.includes("#define CODE_BANK          4"));
  });

  it("generates BANKED_CODE 0 when not in banked mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codegen-nobank-"));
    const gbs = mockGbs();
    const tracks = makeTracks();

    await generateCode(gbs, tracks, dir, {
      bankedCode: { enabled: false, codeBankNum: 0 },
    });

    const header = readFileSync(join(dir, "playlist_data.h"), "utf8");
    assert.ok(header.includes("#define BANKED_CODE        0"));
    assert.ok(!header.includes("#define CODE_BANK"));
  });

  it("uses custom WRAM stack address when provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codegen-wram-"));
    const gbs = mockGbs();
    const tracks = makeTracks();

    await generateCode(gbs, tracks, dir, {
      wram: {
        dataAddr: 0xC500,
        initializedAddr: 0xC5A0,
        stackAddr: 0xC800,
      },
    });

    const header = readFileSync(join(dir, "playlist_data.h"), "utf8");
    assert.ok(header.includes("#define PLAYER_STACK_PTR   0xC800"));
  });

  it("uses playlist title override when provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codegen-title-"));
    const gbs = mockGbs();
    const tracks = makeTracks();

    await generateCode(gbs, tracks, dir, { title: "Custom Album" });

    const header = readFileSync(join(dir, "playlist_data.h"), "utf8");
    assert.ok(header.includes('#define ALBUM_TITLE     "Custom Album"'));
  });
});
