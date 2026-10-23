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
// 5 minutes, and each test costs about 23, mostly the shell and the assets the service worker
// precaches in its fresh context. So a deployed run is opt-in: only tests tagged `@deployed` run, the
// ones that test what only a deployed stack shows (the real API through CloudFront, the headers and
// assets CloudFront serves, the service worker against real caching). Forgetting the tag costs
// deployed coverage, never WAF headroom. They run in one WebKit and one Chromium project, which
// between them cover both engines and both schemes: 5 tests pass and 1 skips, in about 120 requests
// (counted by a proxy in front of the local build in October 2026) of the 1,000, leaving room for
// smoke, the kill switch test and a retry of every test. `--project` still picks any of the six, and
// `--grep` or `--grep-invert` (`-g`, `-G`) replaces the tag. Workers load this file without the CLI's
// arguments, so the project choice reaches them in the environment; the grep needn't, as workers run
// the tests the main process picked.
const deployed = ["iphone-light", "desktop-dark"];
process.env.E2E_ALL_PROJECTS ??=
  !remote || process.argv.some((arg) => arg.startsWith("--project")) ? "1" : "";
const grepOnCli = process.argv.some((arg) => /^(-[gG]|--grep(-invert)?(=|$))/.test(arg));

export default defineConfig({
  testDir: process.env.PLAYWRIGHT_TEST_DIR ?? "e2e",
  grep: remote && !grepOnCli ? /@deployed/ : undefined,
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
