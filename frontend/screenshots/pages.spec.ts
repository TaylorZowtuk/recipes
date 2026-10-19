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
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    const heading = page.getByRole("heading", { level: 1, name: ready, exact: true });
    if (mayBeMissing) {
      const shown = await heading.waitFor({ timeout: 3000 }).then(
        () => true,
        () => false,
      );
      // Skip only when the app itself rendered. BASE may predate the shell, so the sign is that
      // #root has content and nothing threw, not this branch's navigation.
      expect(errors, "uncaught errors").toEqual([]);
      await expect(page.locator("#root > *").first()).toBeAttached();
      test.skip(!shown, `no "${ready}" heading at ${url}: the page is new`);
    } else {
      await expect(heading).toBeVisible();
    }
    expect(errors, "uncaught errors").toEqual([]);
    await page.screenshot({
      path: path.join(outDir, testInfo.project.name, `${name}.png`),
      fullPage: true,
    });
  });
}
