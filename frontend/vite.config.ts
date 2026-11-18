import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

// FastAPI runs on this port in the same container under `make e2e`; `make dev` points API_URL at its
// own container. Locally it serves the stored photos at /images too, as CloudFront does on a stack.
const target = process.env.API_URL ?? "http://127.0.0.1:8787";
const api = { "/api": target, "/images": target };

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // src/sw.ts: a new build takes over on the next launch, or at once on a schema change.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "prompt",
      manifest: {
        name: "Plateful",
        short_name: "Plateful",
        display: "standalone",
        // The dark --bg. An installed Android app shows this behind the system navigation bar in
        // both schemes, and the manifest has no per-scheme colour, so it suits the dark scheme.
        background_color: "#121715",
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
      // The fonts are precached so the app keeps its look offline.
      injectManifest: { globPatterns: ["**/*.{js,css,html,woff2}"] },
    }),
  ],
  server: { proxy: api },
  preview: { proxy: api },
  test: { include: ["src/**/*.test.ts?(x)"] },
});
