import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

// FastAPI runs on this port in the same container under `make e2e`; `make dev` points API_URL at its
// own container.
const api = { "/api": process.env.API_URL ?? "http://127.0.0.1:8787" };

export default defineConfig({
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
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          {
            src: "icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
      },
      // The fonts are precached so the app keeps its look offline. The API, recipe images and
      // robots.txt come from the server as themselves, never as the app's index.html.
      workbox: {
        globPatterns: ["**/*.{js,css,html,woff2}"],
        navigateFallbackDenylist: [/^\/api\//, /^\/images\//, /^\/robots\.txt$/],
      },
    }),
  ],
  server: { proxy: api },
  preview: { proxy: api },
  test: { include: ["src/**/*.test.ts?(x)"] },
});
