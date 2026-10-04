import { defineConfig } from "vite";

// Builds a single self-contained widget.js that customers embed with one <script> tag.
export default defineConfig({
  build: {
    lib: { entry: "src/widget.ts", name: "Vanibot", formats: ["iife"], fileName: () => "widget.js" },
    outDir: "dist",
    emptyOutDir: true,
    minify: true,
  },
});
