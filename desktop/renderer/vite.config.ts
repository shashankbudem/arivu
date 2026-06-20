import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "desktop/renderer",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../dist-desktop/renderer",
    emptyOutDir: true
  },
  server: {
    port: 5173,
    strictPort: true
  }
});
