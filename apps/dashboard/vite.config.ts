import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // During development the dashboard calls the API through this proxy.
    proxy: { "/api": process.env.VITE_API_URL ?? "http://localhost:4000" },
  },
});
