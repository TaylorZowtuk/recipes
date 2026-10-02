import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

// FastAPI runs locally on this port, both in development and under `make e2e`.
const api = { "/api": "http://127.0.0.1:8787" };

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Plateful",
        short_name: "Plateful",
        display: "standalone",
        background_color: "#fbf7f0",
        theme_color: "#fbf7f0",
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
      },
      workbox: { navigateFallbackDenylist: [/^\/api\//] },
    }),
  ],
  server: { proxy: api },
  preview: { proxy: api },
  test: { include: ["src/**/*.test.ts?(x)"] },
});
