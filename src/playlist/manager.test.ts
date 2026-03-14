import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { resolveTrackList, buildTemplateSync, loadPlaylist } from "./manager.js";
import type { ParsedGbs } from "../gbs/types.js";
import type { Playlist } from "./types.js";
import { writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function mockGbs(numSongs = 3): ParsedGbs {
  return {
    header: {
      magic: "GBS",
      version: 1,
      numSongs,
      firstSong: 1,
      loadAddr: 0x3F56,
      initAddr: 0x3F56,
      playAddr: 0x3F7E,
      stackPtr: 0xDFFF,
      timerModulo: 0,
      timerControl: 0,
      title: "Test",
      author: "Author",
      copyright: "2024",
    },
    raw: Buffer.alloc(0x70),
    gbsRomOffset: 0x3EE6,
    usesTimerInterrupt: false,
  };
}

describe("resolveTrackList", () => {
  it("returns auto-generated tracks when no playlist is provided", () => {
    const gbs = mockGbs(3);
    const tracks = resolveTrackList(gbs);

    assert.equal(tracks.length, 3);
    assert.equal(tracks[0].number, 1);
    assert.equal(tracks[0].title, "Track 1");
    assert.equal(tracks[1].number, 2);
    assert.equal(tracks[1].title, "Track 2");
    assert.equal(tracks[2].number, 3);
    assert.equal(tracks[2].title, "Track 3");
  });

  it("returns playlist tracks when playlist is provided", () => {
    const gbs = mockGbs(5);
    const playlist: Playlist = {
      gbs: "test.gbs",
      tracks: [
        { number: 1, title: "Opening Theme" },
        { number: 3, title: "Battle" },
      ],
    };
    const tracks = resolveTrackList(gbs, playlist);

    assert.equal(tracks.length, 2);
    assert.equal(tracks[0].title, "Opening Theme");
    assert.equal(tracks[1].title, "Battle");
  });

});

describe("buildTemplateSync", () => {
  it("returns a playlist template with auto-generated track names", () => {
    const gbs = mockGbs(3);
    const result = buildTemplateSync(gbs, "game.gbs");

    assert.equal(result.gbs, "game.gbs");
    assert.equal(result.tracks.length, 3);
    assert.equal(result.tracks[0].number, 1);
    assert.equal(result.tracks[0].title, "Track 1");
    assert.equal(result.tracks[2].number, 3);
    assert.equal(result.tracks[2].title, "Track 3");
  });

  it("handles single-track GBS", () => {
    const gbs = mockGbs(1);
    const result = buildTemplateSync(gbs, "single.gbs");

    assert.equal(result.tracks.length, 1);
    assert.equal(result.tracks[0].number, 1);
  });
});

describe("loadPlaylist", () => {
  let tempDir: string;

  function writeTempJson(filename: string, data: unknown): string {
    if (!tempDir) {
      tempDir = mkdtempSync(join(tmpdir(), "playlist-test-"));
    }
    const path = join(tempDir, filename);
    writeFileSync(path, JSON.stringify(data), "utf8");
    return path;
  }

  it("loads a valid playlist file", async () => {
    const path = writeTempJson("valid.json", {
      gbs: "test.gbs",
      tracks: [{ number: 1, title: "Track One" }],
    });
    const playlist = await loadPlaylist(path);
    assert.equal(playlist.gbs, "test.gbs");
    assert.equal(playlist.tracks.length, 1);
  });

  it("throws on missing gbs field", async () => {
    const path = writeTempJson("no-gbs.json", {
      tracks: [{ number: 1, title: "Track" }],
    });
    await assert.rejects(() => loadPlaylist(path), /gbs.*string/i);
  });

  it("throws on missing tracks field", async () => {
    const path = writeTempJson("no-tracks.json", {
      gbs: "test.gbs",
    });
    await assert.rejects(() => loadPlaylist(path), /tracks.*array/i);
  });

  it("throws on track with non-integer number", async () => {
    const path = writeTempJson("bad-number.json", {
      gbs: "test.gbs",
      tracks: [{ number: 1.5, title: "Track" }],
    });
    await assert.rejects(() => loadPlaylist(path), /number/i);
  });

  it("throws on track with missing title", async () => {
    const path = writeTempJson("no-title.json", {
      gbs: "test.gbs",
      tracks: [{ number: 1 }],
    });
    await assert.rejects(() => loadPlaylist(path), /title/i);
  });

  it("throws on duplicate track numbers", async () => {
    const path = writeTempJson("dup.json", {
      gbs: "test.gbs",
      tracks: [
        { number: 1, title: "A" },
        { number: 1, title: "B" },
      ],
    });
    await assert.rejects(() => loadPlaylist(path), /duplicate/i);
  });
});
