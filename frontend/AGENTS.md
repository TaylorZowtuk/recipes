# Frontend

- Call the API only through `src/api/client.ts`. Its types come from `src/api/schema.ts`, which `make api-client` generates: never edit that file by hand.
- Vitest tests sit next to the code as `*.test.ts(x)`. Playwright tests go in `e2e/`. There are no pixel-diff snapshots.
- Playwright runs in the toolchain container, built on Microsoft's Playwright image: the iPhone projects run in WebKit, Pixel and desktop in Chromium. The image's tag follows the `@playwright/test` version in the lockfile, so its browsers always match. Against a deployed stack (`E2E_BASE_URL`) only tests tagged `@deployed` run, on `iphone-light` and `desktop-dark`, unless `--grep`, `--grep-invert` or `--project` says otherwise: see the comment in `playwright.config.ts`. Tag a test `@deployed` (`test(title, { tag: "@deployed" }, …)`) only when it tests something only a deployed stack shows: the real API through CloudFront, the headers and assets CloudFront serves, or the service worker against real caching. Each one costs about 46 requests (23 in each of the two projects) of the WAF's per-IP limit on every staging deploy.
- To screenshot a new page for UI PRs, add it to `screenshots/pages.spec.ts`.
