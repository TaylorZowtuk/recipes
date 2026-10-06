import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

// FastAPI runs on this port in the same container under `make e2e`; `make dev` points API_URL at its
// own container.
const api = { "/api": process.env.API_URL ?? "http://127.0.0.1:8787" };

export default defineConfig({
  // The toolchain image keeps node_modules out of the checkout, and Vite's cache with it.
  cacheDir: process.env.VITE_CACHE_DIR || undefined,
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Plateful",
        short_name: "Plateful",
        display: "standalone",
        background_color: "#F7F8F5",
        theme_color: "#2E5E45",
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
      },
      workbox: { navigateFallbackDenylist: [/^\/api\//] },
    }),
  ],
  server: { proxy: api },
  preview: { proxy: api },
  test: { include: ["src/**/*.test.ts?(x)"] },
});
