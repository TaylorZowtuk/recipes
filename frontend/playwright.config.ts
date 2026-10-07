import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// `make screenshots` points APP_ROOT at a checkout of the base branch to take "before" shots.
const root = path.resolve(process.env.APP_ROOT ?? "..");

// Runs in the toolchain container (`make e2e`), built on Microsoft's Playwright image, so each
// device gets its own engine: WebKit for the iPhone, Chromium for the Pixel and desktop.
const viewports = {
  iphone: devices["iPhone 15"],
  pixel: devices["Pixel 7"],
  desktop: devices["Desktop Chrome"],
};
const schemes = ["light", "dark"] as const;

export default defineConfig({
  testDir: process.env.PLAYWRIGHT_TEST_DIR ?? "e2e",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: "http://127.0.0.1:4173", trace: "retain-on-failure" },
  projects: Object.entries(viewports).flatMap(([name, device]) =>
    schemes.map((colorScheme) => ({
      name: `${name}-${colorScheme}`,
      use: { ...device, colorScheme },
    })),
  ),
  webServer: [
    {
      command: "uv run --locked python -m recipes.e2e_server",
      cwd: path.join(root, "backend"),
      url: "http://127.0.0.1:8787/api/sync",
      reuseExistingServer: false,
    },
    {
      command: "pnpm exec vite build && pnpm exec vite preview --host 127.0.0.1 --strictPort",
      cwd: path.join(root, "frontend"),
      url: "http://127.0.0.1:4173",
      reuseExistingServer: false,
    },
  ],
});
