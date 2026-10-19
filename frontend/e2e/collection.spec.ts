import { expect, type Locator, type Page, test } from "@playwright/test";

// From the synthetic seed the e2e server loads (backend/src/recipes/seed.py).
const recipeId = "01K7SEED000000000000000002";
const recipeTitle = "Sesame Noodles with Crispy Tofu";
const recipePath = `/recipes/${recipeId}/sesame-noodles-with-crispy-tofu`;
const pendingTitle = /^Grandma-Style Slow-Simmered Beef and Barley Stew/;

const grid = (page: Page) => page.getByRole("list", { name: "Recipes" });
const cardTitles = (page: Page) => grid(page).locator(".card-title");

async function expectTapTarget(target: Locator) {
  const box = await target.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(50);
  expect(box?.height).toBeGreaterThanOrEqual(50);
}

test("browse the Collection, search it and open a recipe", async ({ page }) => {
  await page.goto("/recipes");

  // Every seeded card, sorted by title, two to a row even on a phone.
  await expect(cardTitles(page)).toHaveCount(7);
  const titles = await cardTitles(page).allTextContents();
  expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
  const items = grid(page).getByRole("listitem");
  const [a, b] = [await items.nth(0).boundingBox(), await items.nth(1).boundingBox()];
  expect(a?.y).toBe(b?.y);

  // A card without a photo shows an empty plate with its initial, then the title, site and time.
  const card = grid(page).getByRole("link", { name: new RegExp(recipeTitle) });
  await expect(card.locator(".plate")).toHaveText("S");
  await expect(card).toContainText("Example Noodle House");
  await expect(card).toContainText("30 min");
  await expectTapTarget(card);

  // Only the Pending recipe says enrichment is pending.
  await expect(grid(page).getByText("Enrichment pending")).toHaveCount(1);
  await expect(grid(page).getByRole("link", { name: pendingTitle })).toContainText(
    "Enrichment pending",
  );

  // The search ignores case and accents.
  const search = page.getByRole("searchbox", { name: "Search recipe titles" });
  await expectTapTarget(search);
  await search.fill("NOODLÉS");
  await expect(cardTitles(page)).toHaveText([recipeTitle]);
  await search.fill("no such dish");
  await expect(page.getByText("No recipes match “no such dish”.")).toBeVisible();
  await search.fill("crispy");
  await grid(page)
    .getByRole("link", { name: new RegExp(recipeTitle) })
    .click();

  await expect(page).toHaveURL(new RegExp(`${recipePath}$`));
  await expect(page.getByRole("heading", { level: 1, name: recipeTitle })).toBeFocused();
  await expect(page).toHaveTitle(`${recipeTitle} · Plateful`);
  const main = page.getByRole("main");
  await expect(main).toContainText("Example Noodle House");
  await expect(main).toContainText("30 min");
  await expect(page.getByRole("button", { name: "Back" })).toBeVisible();

  // Ingredients first: the raw lines under their Component headings.
  const tabs = page.getByRole("tablist", { name: "Recipe" });
  const ingredientsTab = tabs.getByRole("tab", { name: "Ingredients" });
  await expect(ingredientsTab).toHaveAttribute("aria-selected", "true");
  await expectTapTarget(ingredientsTab);
  let panel = page.getByRole("tabpanel", { name: "Ingredients" });
  await expect(panel.getByRole("heading", { level: 2 })).toHaveText([
    "For the sauce",
    "For the tofu",
    "For the noodles",
  ]);
  await expect(panel.getByRole("listitem").first()).toHaveText("3 tbsp tahini");
  await expect(panel.getByRole("listitem")).toHaveCount(9);

  // The arrow keys move between the tabs. Steps are numbered through the whole recipe.
  await ingredientsTab.focus();
  await page.keyboard.press("ArrowRight");
  const stepsTab = tabs.getByRole("tab", { name: "Steps" });
  await expect(stepsTab).toBeFocused();
  await expect(stepsTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "Ingredients" })).toBeHidden();
  panel = page.getByRole("tabpanel", { name: "Steps" });
  await expect(panel.getByRole("heading", { level: 2 })).toHaveCount(3);
  await expect(panel.getByRole("listitem")).toHaveCount(5);
  await expect(panel.getByRole("listitem").nth(1)).toHaveText("Toss the tofu in cornstarch.");
  await expect(panel.getByRole("list").nth(1)).toHaveAttribute("start", "2");

  // About: the Stated Times and yield as written, and the Source in a new tab.
  await tabs.getByRole("tab", { name: "About" }).click();
  panel = page.getByRole("tabpanel", { name: "About" });
  for (const fact of ["Prep15 minutes", "Cook15 minutes", "Total30 minutes", "Yield4 bowls"]) {
    await expect(panel).toContainText(fact);
  }
  const source = panel.getByRole("link", { name: "Example Noodle House" });
  await expect(source).toHaveAttribute("href", "https://example.com/sesame-noodles-crispy-tofu");
  await expect(source).toHaveAttribute("target", "_blank");
  await expect(source).toHaveAttribute("rel", /noopener/);

  // Back returns to the Collection.
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/recipes$/);
  await expect(cardTitles(page)).toHaveCount(7);
});

test("a stale or missing slug still opens the recipe and corrects itself", async ({ page }) => {
  for (const path of [`/recipes/${recipeId}/wrong-slug`, `/recipes/${recipeId}`]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: recipeTitle })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${recipePath}$`));
  }
});

test("an unknown recipe says it isn't there", async ({ page }) => {
  await page.goto("/recipes/01K7SEED000000000000000099/whatever");
  await expect(page.getByRole("heading", { level: 1, name: "Recipe not found" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Browse the Collection" })).toBeVisible();
});

test("a spreadsheet recipe links to its entry", async ({ page }) => {
  await page.goto("/recipes");
  await page.getByRole("link", { name: /Smoky Taco Seasoning/ }).click();
  await page.getByRole("tab", { name: "About" }).click();
  const source = page.getByRole("tabpanel", { name: "About" }).getByRole("link");
  await expect(source).toHaveText("Smoky Taco Seasoning");
  await expect(source).toHaveAttribute("href", "https://sheets.example.com/d/spice-blends");
});
