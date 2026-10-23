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

// E2E_BASE_URL points the suite at a deployed stack, such as staging, instead of a local build.
// Its report is a public CI artifact, so it records no traces: they hold request headers and storage.
const remote = process.env.E2E_BASE_URL;

// Against a deployed stack every request counts toward the WAF's per-IP rate limit, about 1,000 per
// 5 minutes, so the suite runs one WebKit and one Chromium project, which between them cover both
// engines and both schemes. A run of these two makes about 800 requests (34 tests, counted by a proxy
// in front of the local build in October 2026). Smoke and the kill switch test run just before it from
// the same IP, so about 150 are left, before CI's retry of each failing test. Each test costs about 23,
// mostly the shell and the assets the service worker precaches in its fresh context, and runs in both
// projects. `--project` still picks any of the six. Workers load this file without the CLI's
// arguments, so the choice reaches them in the environment.
const deployed = ["iphone-light", "desktop-dark"];
process.env.E2E_ALL_PROJECTS ??=
  !remote || process.argv.some((arg) => arg.startsWith("--project")) ? "1" : "";

export default defineConfig({
  testDir: process.env.PLAYWRIGHT_TEST_DIR ?? "e2e",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: remote ?? "http://127.0.0.1:4173", trace: remote ? "off" : "retain-on-failure" },
  projects: Object.entries(viewports)
    .flatMap(([name, device]) =>
      schemes.map((colorScheme) => ({
        name: `${name}-${colorScheme}`,
        use: { ...device, colorScheme },
      })),
    )
    .filter(({ name }) => process.env.E2E_ALL_PROJECTS || deployed.includes(name)),
  webServer: remote
    ? []
    : [
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
