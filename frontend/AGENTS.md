# Frontend

- Call the API only through `src/api/client.ts`. Its types come from `src/api/schema.ts`, which `make api-client` generates: never edit that file by hand.
- Vitest tests sit next to the code as `*.test.ts(x)`. Playwright tests go in `e2e/`. There are no pixel-diff snapshots.
- Playwright runs in the toolchain container, built on Microsoft's Playwright image: the iPhone projects run in WebKit, Pixel and desktop in Chromium. Bumping `@playwright/test` means bumping the image tag in `docker/Dockerfile` to match.
- To screenshot a new page for UI PRs, add it to `screenshots/pages.spec.ts`.
