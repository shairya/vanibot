import { resolve } from "node:path";
import { defineConfig } from "vite";

// The marketing website: plain HTML pages plus a little TypeScript. Set VITE_API_URL and VITE_DASHBOARD_URL when building.
export default defineConfig({
  build: {
    rollupOptions: {
      input: Object.fromEntries(["index", "pricing", "demo", "contact", "privacy", "terms"].map((p) => [p, resolve(__dirname, `${p}.html`)])),
    },
  },
});
