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

for (const { name, path: url, ready } of pages) {
  test(name, async ({ page }, testInfo) => {
    await page.goto(url);
    await expect(page.getByRole("heading", { name: ready })).toBeVisible();
    await page.screenshot({
      path: path.join(outDir, testInfo.project.name, `${name}.png`),
      fullPage: true,
    });
  });
}
