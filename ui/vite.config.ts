import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  root: "ui",
  plugins: [preact()],
  build: {
    outDir: "../dist/ui",
    emptyOutDir: true,
  },
});
