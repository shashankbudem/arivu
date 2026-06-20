import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["desktop/main/main.ts"],
    format: ["esm"],
    platform: "node",
    external: ["electron"],
    outDir: "dist-desktop/main",
    sourcemap: true,
    clean: true
  },
  {
    entry: ["desktop/main/preload.ts"],
    format: ["cjs"],
    platform: "node",
    external: ["electron"],
    outDir: "dist-desktop/preload",
    sourcemap: true,
    clean: true,
    outExtension() {
      return { js: ".cjs" };
    }
  }
]);

