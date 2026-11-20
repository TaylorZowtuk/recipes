import { expect, type Page, test } from "@playwright/test";

// Our Version is page logic on a seeded recipe; a local build covers it.
test.skip(!!process.env.E2E_BASE_URL, "Our Version's view is page logic, covered by a local build");

test.use({ serviceWorkers: "block" });

// The seed's Our Version: less salt, garlic in place of the thyme, step 3 edited, and a note.
const CHICKEN_PATH = "/recipes/01K7SEED000000000000000001/lemon-herb-roast-chicken";

const panel = (page: Page, name: string) => page.getByRole("tabpanel", { name });
const line = (page: Page, name: string) =>
  panel(page, "Ingredients").getByRole("listitem").filter({ hasText: name });
const notes = (page: Page, tab: string) => panel(page, tab).locator(".our-version-note");

test("a recipe shows its Our Version, marked, and the Adjust sheet switches to the Original", async ({
  page,
}) => {
  await page.goto(CHICKEN_PATH);
  await expect(line(page, "kosher salt").locator(".ingredient-amount")).toHaveText("½ tsp");
  await expect(line(page, "kosher salt")).toContainText("was 1 tsp");
  await expect(line(page, "garlic cloves")).toContainText("added in Our Version");
  await expect(line(page, "thyme")).toHaveCount(0);

  await page.getByRole("tab", { name: "Steps" }).click();
  const third = panel(page, "Steps").getByRole("listitem").nth(2);
  await expect(third).toContainText("stuff it with the lemons and garlic.");
  await expect(third).toContainText("changed in Our Version");

  await page.getByRole("tab", { name: "About" }).click();
  await expect(panel(page, "About")).toContainText("Less salt, and garlic in place of the thyme.");

  await page.getByRole("button", { name: /^Adjust/ }).click();
  const sheet = page.getByRole("dialog", { name: "Adjust" });
  await sheet.getByRole("button", { name: "Original", exact: true }).click();
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("button", { name: /^Adjust/ })).toHaveText("Adjust · Original");
  await expect(panel(page, "About")).not.toContainText("garlic in place of the thyme");

  await page.getByRole("tab", { name: "Ingredients" }).click();
  await expect(line(page, "fresh thyme")).toHaveCount(1);
  await expect(line(page, "garlic cloves")).toHaveCount(0);
  await expect(line(page, "kosher salt").locator(".ingredient-amount")).toHaveText("1 tsp");
  await expect(notes(page, "Ingredients")).toHaveCount(0);
  await page.getByRole("tab", { name: "Steps" }).click();
  await expect(panel(page, "Steps").getByRole("listitem").nth(2)).toContainText(
    "stuff it with the lemons and thyme.",
  );
  await expect(notes(page, "Steps")).toHaveCount(0);
});
