import path from "node:path";
import { expect, test } from "@playwright/test";

// Add a page here when a UI change needs before/after screenshots of it.
const pages = [
  { name: "recipes", path: "/recipes", ready: "Collection" },
  { name: "week", path: "/week", ready: "Week Plan" },
  { name: "fridge", path: "/fridge", ready: "Fridge" },
  { name: "sites", path: "/sites", ready: "Favorite Sites" },
  { name: "sign-in", path: "/sign-in", ready: "Editor sign-in" },
];

const outDir = process.env.SCREENSHOT_DIR ?? "screenshots-out";
// Set for the base branch's run, which may predate some of the pages.
const mayBeMissing = !!process.env.SCREENSHOT_MAY_BE_MISSING;

for (const { name, path: url, ready } of pages) {
  test(name, async ({ page }, testInfo) => {
    await page.goto(url);
    const heading = page.getByRole("heading", { name: ready });
    if (mayBeMissing) {
      const shown = await heading.waitFor({ timeout: 3000 }).then(
        () => true,
        () => false,
      );
      test.skip(!shown, `no "${ready}" heading at ${url}: the page is new`);
    } else {
      await expect(heading).toBeVisible();
    }
    await page.screenshot({
      path: path.join(outDir, testInfo.project.name, `${name}.png`),
      fullPage: true,
    });
  });
}
