# Frontend

- Call the API only through `src/api/client.ts`. Its types come from `src/api/schema.ts`, which `make api-client` generates: never edit that file by hand.
- Vitest tests sit next to the code as `*.test.ts(x)`. Playwright tests go in `e2e/`. There are no pixel-diff snapshots.
- Playwright runs in the toolchain container, built on Microsoft's Playwright image: the iPhone projects run in WebKit, Pixel and desktop in Chromium. The image's tag follows the `@playwright/test` version in the lockfile, so its browsers always match. Against a deployed stack (`E2E_BASE_URL`) only tests tagged `@deployed` run, on `iphone-light` and `desktop-dark`, unless `--grep`, `--grep-invert` or `--project` says otherwise: see the comment in `playwright.config.ts`. Tag a test `@deployed` (`test(title, { tag: "@deployed" }, …)`) only when it tests something only a deployed stack shows: the real API through CloudFront, the headers and assets CloudFront serves, or the service worker against real caching. Each one costs about 46 requests (23 in each of the two projects) of the WAF's per-IP limit on every staging deploy.
- To screenshot a new page for UI PRs, add it to `screenshots/pages.spec.ts`.
- To test as an editor in e2e, do what `e2e/sign-in.spec.ts` does: stub `https://accounts.google.com/gsi/client` with `page.route`, block service workers in that context (in WebKit, `page.route` stops seeing requests once one registers), and sign in with a `fake:<email>` credential, which only the local API accepts (`fake:editor@example.com` is an editor). Such specs skip when `E2E_BASE_URL` is set.
- Under local e2e and `make dev`, `https://plateful.test/<slug>` serves a synthetic recipe (see `backend/src/recipes/local.py`), and each Source can be ingested once on the run's one shared server. So add-recipe specs give every page a path unique per project and attempt (`testInfo.project.name`, `retry` and `repeatEachIndex`), aren't `@deployed`, and skip when `E2E_BASE_URL` is set.
- A step script for the [watched browser](../AGENTS.md#watched-browser) (`make browser-run < step.mjs`) is an ES module whose default export gets `{ browser, context, page, out }`: the CDP-connected Playwright `Browser`, its default context, the app's page (the first tab at the app's origin; the step fails when there is none) and `/out`, which is the host's `OUT` (default `.screenshots/browser`, gitignored). Import only Node builtins, no packages. Never close `page` (pages you open yourself you may close); afterwards the runner calls `browser.close()`, which over CDP only disconnects. A step that throws exits non-zero. The step runs in the browser container's network namespace, so it reaches the app's origin as the browser does, and for local `make dev` also `web` and `api` on the worktree's Compose network.

  ```js
  export default async ({ page, out }) => {
    await page.getByRole("link", { name: "Week" }).click();
    console.log(await page.title());
    await page.screenshot({ path: `${out}/week.png` });
  };
  ```
