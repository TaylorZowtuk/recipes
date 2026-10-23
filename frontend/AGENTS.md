# Frontend

- Call the API only through `src/api/client.ts`. Its types come from `src/api/schema.ts`, which `make api-client` generates: never edit that file by hand.
- Vitest tests sit next to the code as `*.test.ts(x)`. Playwright tests go in `e2e/`. There are no pixel-diff snapshots.
- Playwright runs in the toolchain container, built on Microsoft's Playwright image: the iPhone projects run in WebKit, Pixel and desktop in Chromium. The image's tag follows the `@playwright/test` version in the lockfile, so its browsers always match.
- To screenshot a new page for UI PRs, add it to `screenshots/pages.spec.ts`.
- To test as an editor in e2e, do what `e2e/sign-in.spec.ts` does: stub `https://accounts.google.com/gsi/client` with `page.route`, block service workers in that context (in WebKit, `page.route` stops seeing requests once one registers), and sign in with a `fake:<email>` credential, which only the local API accepts (`fake:editor@example.com` is an editor). Such specs skip when `E2E_BASE_URL` is set.
