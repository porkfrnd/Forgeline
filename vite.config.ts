import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { cpSync } from "node:fs";
import { join } from "node:path";

// Every face we bundle is OFL-1.1, and OFL-1.1 requires the licence to travel
// with the font. The woff2 files get hashed into dist/web/assets by Vite; the
// licences are copied in by hand once the bundle exists, so the shipped package
// carries them even though they were never imported.
const FONT_LICENCE_SOURCES = [
  "barlow-condensed",
  "ibm-plex-sans",
  "jetbrains-mono",
  "source-serif-4",
];

export default defineConfig({
  root: fileURLToPath(new URL("./src/web", import.meta.url)),
  plugins: [
    react(),
    {
      name: "forgeline-font-licences",
      closeBundle() {
        // Runs only for a real build, never for the dev server.
        const outDir = fileURLToPath(new URL("./dist/web", import.meta.url));
        const dest = join(outDir, "font-licences");
        for (const pkg of FONT_LICENCE_SOURCES) {
          cpSync(
            fileURLToPath(new URL(`./node_modules/@fontsource/${pkg}/LICENSE`, import.meta.url)),
            join(dest, `${pkg}-LICENSE.txt`),
          );
        }
      },
    },
  ],
  build: {
    outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
    emptyOutDir: true,
  },
});
