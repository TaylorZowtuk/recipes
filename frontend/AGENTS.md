# Frontend

- Call the API only through `src/api/client.ts`. Its types come from `src/api/schema.ts`, which `make api-client` generates: never edit that file by hand.
- Vitest tests sit next to the code as `*.test.ts(x)`. Playwright tests go in `e2e/`. There are no pixel-diff snapshots.
- Every Playwright project runs in Chromium, so `make e2e` needs no system packages.
- To screenshot a new page for UI PRs, add it to `screenshots/pages.spec.ts`.
