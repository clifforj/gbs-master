import { defineConfig, Plugin } from "vite";
import { resolve } from "path";
import { copyFileSync, readdirSync } from "fs";

/** Copy only .gb and .json files from the templates directory into dist. */
function copyTemplates(): Plugin {
  const templatesDir = resolve(__dirname, "../templates");
  return {
    name: "copy-templates",
    writeBundle(options) {
      const outDir = options.dir!;
      for (const file of readdirSync(templatesDir)) {
        if (file.endsWith(".gb") || file.endsWith(".json")) {
          copyFileSync(resolve(templatesDir, file), resolve(outDir, file));
        }
      }
    },
  };
}

export default defineConfig({
  root: resolve(__dirname, "."),
  base: "./",
  publicDir: false,
  build: {
    outDir: resolve(__dirname, "../dist"),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "../src"),
    },
  },
  plugins: [copyTemplates()],
});
