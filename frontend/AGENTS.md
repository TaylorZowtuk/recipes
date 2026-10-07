# Frontend

- Call the API only through `src/api/client.ts`. Its types come from `src/api/schema.ts`, which `make api-client` generates: never edit that file by hand.
- Vitest tests sit next to the code as `*.test.ts(x)`. Playwright tests go in `e2e/`. There are no pixel-diff snapshots.
- Playwright runs in the toolchain container, built on Microsoft's Playwright image: the iPhone projects run in WebKit, Pixel and desktop in Chromium. The image's tag follows the `@playwright/test` version in the lockfile, so its browsers always match.
- To screenshot a new page for UI PRs, add it to `screenshots/pages.spec.ts`.
