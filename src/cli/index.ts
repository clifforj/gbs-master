#!/usr/bin/env node
/**
 * gbs-master CLI
 *
 * Commands:
 *   playlist init <file.gbs>         — Generate a playlist template JSON
 *   build <file.gbs> -o <out.gb>     — Build a playable .gb ROM
 */

import { Command } from "commander";
import { writeFile } from "fs/promises";
import { resolve, dirname, basename, extname } from "path";
import { parseGbsFile } from "../gbs/parser.js";
import { buildTemplateSync } from "../playlist/manager.js";
import { build } from "../build/builder.js";

const program = new Command();

program
  .name("gbs-master")
  .description(
    "Build playable Game Boy ROMs from GBS sound files - complete with track " +
    "lists, and broad driver compatibility.")
  .version("1.0.0");

// ── playlist init ─────────────────────────────────────────────────────────────

program
  .command("playlist")
  .description("Manage playlist metadata")
  .addCommand(
    new Command("init")
      .description(
        "Generate a playlist JSON template from a GBS file.\n" +
          "Edit the generated file to add track titles."
      )
      .argument("<gbs>", "Path to the .gbs file")
      .option("-o, --output <file>", "Output playlist path (default: <gbs-name>.playlist.json)")
      .action(async (gbsArg: string, opts: { output?: string }) => {
        const gbsPath = resolve(gbsArg);

        try {
          const gbs = await parseGbsFile(gbsPath);
          const { header } = gbs;

          const playlist = buildTemplateSync(gbs, basename(gbsPath));
          const outPath =
            opts.output ??
            resolve(dirname(gbsPath), basename(gbsPath, extname(gbsPath)) + ".playlist.json");

          await writeFile(outPath, JSON.stringify(playlist, null, 2) + "\n", "utf8");

          console.log(`Generated playlist template: ${outPath}`);
          console.log(`  Title:  ${header.title}`);
          console.log(`  Author: ${header.author}`);
          console.log(`  Tracks: ${header.numSongs}`);
          console.log();
          console.log("Open the file and fill in the track titles.");
          console.log("Then run:  gbs-master build <file.gbs> --playlist <playlist.json> -o out.gb");
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
      })
  );

// ── build ─────────────────────────────────────────────────────────────────────

program
  .command("build")
  .description("Build a playable Game Boy ROM from a GBS file")
  .argument("<gbs>", "Path to the .gbs file")
  .requiredOption("-o, --output <file>", "Output .gb ROM path")
  .option("-p, --playlist <file>", "Path to a playlist JSON file for track titles")
  .option("--cover <file>", "Path to a 16x16 PNG album cover (default: built-in disc icon)")
  .option("--gbdk-home <path>", "Path to GBDK-2020 installation (overrides GBDK_HOME env var)")
  .action(
    async (
      gbsArg: string,
      opts: { output: string; playlist?: string; cover?: string; gbdkHome?: string }
    ) => {
      try {
        await build({
          gbsPath: resolve(gbsArg),
          outputPath: resolve(opts.output),
          playlistPath: opts.playlist ? resolve(opts.playlist) : undefined,
          coverPath: opts.cover ? resolve(opts.cover) : undefined,
          gbdkHome: opts.gbdkHome,
        });
      } catch (err) {
        console.error(`\nBuild failed: ${(err as Error).message}`);
        process.exit(1);
      }
    }
  );

program.parse();
