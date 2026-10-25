import { expect, type Locator, type Page, test } from "@playwright/test";

// A deployed stack (E2E_BASE_URL) holds its own Collection, not the seed these tests read.
test.skip(!!process.env.E2E_BASE_URL, "needs the local seed");

// From the synthetic seed the e2e server loads (backend/src/recipes/seed.py).
const recipeId = "01K7SEED000000000000000002";
const recipeTitle = "Sesame Noodles with Crispy Tofu";
const recipePath = `/recipes/${recipeId}/sesame-noodles-with-crispy-tofu`;
const pendingTitle = /^Grandma-Style Slow-Simmered Beef and Barley Stew/;

const grid = (page: Page) => page.getByRole("list", { name: "Recipes" });
const cardTitles = (page: Page) => grid(page).locator(".card-title");
// The seeded cards. Tests in other files add recipes to the same local API as these run, so the
// grid may hold more than the seed.
const seededCards = (page: Page) => grid(page).locator('a[href^="/recipes/01K7SEED"]');
const seededCount = 7;

// How many cards the grid shows, once the seeded ones have loaded.
async function shownCount(page: Page) {
  await expect(seededCards(page)).toHaveCount(seededCount);
  return cardTitles(page).count();
}
// The Shell's sync status is the other status on every screen.
const resultCount = (page: Page) => page.getByRole("status").and(page.locator(".result-count"));

async function expectTapTarget(target: Locator) {
  const box = await target.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(50);
  expect(box?.height).toBeGreaterThanOrEqual(50);
}

test("browse the Collection, search it and open a recipe", async ({ page }) => {
  await page.goto("/recipes");

  // Every seeded card, sorted by title, two to a row even on a phone.
  const total = await shownCount(page);
  const titles = await cardTitles(page).allTextContents();
  expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
  const items = grid(page).getByRole("listitem");
  const [a, b] = [await items.nth(0).boundingBox(), await items.nth(1).boundingBox()];
  expect(a?.y).toBe(b?.y);

  // A card shows its Preview Photo's card-size copy about its Focal Point, then the title, site
  // and time. One without a photo shows the Empty Plate with its initial.
  const card = grid(page).getByRole("link", { name: new RegExp(recipeTitle) });
  const photo = card.locator(".plate img");
  await expect(photo).toHaveAttribute("src", /^\/images\/[0-9a-f]+-card\.webp$/);
  await expect(photo).toHaveCSS("object-position", "30% 40%");
  await expect(grid(page).getByRole("link", { name: pendingTitle }).locator(".plate")).toHaveText(
    "G",
  );
  await expect(card).toContainText("Example Noodle House");
  await expect(card).toContainText("30 min");
  await expectTapTarget(card);

  // Of the seeded recipes, only the Pending one says enrichment is pending.
  await expect(seededCards(page).filter({ hasText: "Enrichment pending" })).toHaveCount(1);
  await expect(grid(page).getByRole("link", { name: pendingTitle })).toContainText(
    "Enrichment pending",
  );

  // The search ignores case and accents, and a status line says how many recipes match.
  const search = page.getByRole("searchbox", { name: "Search recipe titles" });
  await expectTapTarget(search);
  await expect(resultCount(page)).toHaveText(`${total} recipes`);
  await search.fill("NOODLÉS");
  await expect(cardTitles(page)).toHaveText([recipeTitle]);
  await expect(resultCount(page)).toHaveText("1 recipe");
  await search.fill("no such dish");
  await expect(resultCount(page)).toHaveText("No recipes match “no such dish”.");
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
  const source = panel.getByRole("link", {
    name: "Example Noodle House (opens in a new tab)",
    exact: true,
  });
  await expect(source).toHaveAttribute("href", "https://example.com/sesame-noodles-crispy-tofu");
  await expect(source).toHaveAttribute("target", "_blank");
  await expect(source).toHaveAttribute("rel", /noopener/);

  // Back returns to the Collection.
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/recipes$/);
  await expect(seededCards(page)).toHaveCount(seededCount);
});

test("a stale or missing slug still opens the recipe and corrects itself", async ({ page }) => {
  for (const path of [`/recipes/${recipeId}/wrong-slug`, `/recipes/${recipeId}`]) {
    await page.goto("/recipes");
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: recipeTitle })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${recipePath}$`));

    // The correction replaces the address it was opened at, so one Back leaves the recipe.
    await page.goBack();
    await expect(page).toHaveURL(/\/recipes$/);
  }
});

// These tests fail one request with page.route. Once the app's service worker takes control of the
// page (it claims it as soon as it activates), WebKit sends the page's fetches through it, and
// page.route no longer sees them. So the service worker stays out of the way here.
test.describe("with no service worker", () => {
  test.use({ serviceWorkers: "block" });

  test("a Collection that fails to load can be tried again", async ({ page }) => {
    let failed = false;
    await page.route("**/api/collection*", (route) => {
      if (failed) return route.continue();
      failed = true;
      return route.fulfill({ status: 503 });
    });
    await page.goto("/recipes");

    await expect(page.getByRole("alert")).toHaveText("The Collection couldn’t be loaded.");
    await page.getByRole("button", { name: "Try again" }).click();
    const total = await shownCount(page);
    await expect(page.getByRole("alert")).toHaveCount(0);
    // The button is gone, so focus is on the status line rather than lost to the page.
    await expect(resultCount(page)).toBeFocused();
    await expect(resultCount(page)).toHaveText(`${total} recipes`);
  });

  for (const [what, url] of [
    ["Collection", "**/api/collection*"],
    ["recipe", `**/api/recipes/${recipeId}*`],
  ] as const) {
    test(`a recipe whose ${what} fails to load can be tried again`, async ({ page }) => {
      let failed = false;
      await page.route(url, (route) => {
        if (failed) return route.continue();
        failed = true;
        return route.fulfill({ status: 503 });
      });
      await page.goto(recipePath);

      await expect(page.getByRole("alert")).toHaveText("The recipe couldn’t be loaded.");
      await page.getByRole("button", { name: "Try again" }).click();
      await expect(page.getByRole("tab", { name: "Ingredients" })).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.getByRole("main").getByRole("status")).toBeFocused();
    });
  }

  test("a card whose photo fails to load shows the Empty Plate", async ({ page }) => {
    await page.route("**/images/*-card.webp", (route) => route.fulfill({ status: 404 }));
    await page.goto("/recipes");

    // Scrolled into view, since a card's photo loads lazily.
    const card = grid(page).getByRole("link", { name: new RegExp(recipeTitle) });
    await card.scrollIntoViewIfNeeded();
    await expect(card.locator(".plate-initial")).toHaveText("S");
    await expect(card.locator(".plate img")).toHaveCount(0);
  });
});

test("an unknown recipe says it isn't there", async ({ page }) => {
  await page.goto("/recipes/01K7SEED000000000000000099/whatever");
  await expect(page.getByRole("heading", { level: 1, name: "Recipe not found" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("status")).toHaveText(
    "There’s no recipe at this address.",
  );
  await expect(page.getByRole("link", { name: "Browse the Collection" })).toBeVisible();
});

test("a spreadsheet recipe links to its entry", async ({ page }) => {
  await page.goto("/recipes");
  await page.getByRole("link", { name: /Smoky Taco Seasoning/ }).click();
  await page.getByRole("tab", { name: "About" }).click();
  const source = page.getByRole("tabpanel", { name: "About" }).getByRole("link");
  await expect(source).toHaveAccessibleName("Smoky Taco Seasoning (opens in a new tab)");
  await expect(source).toHaveAttribute("href", "https://sheets.example.com/d/spice-blends");
});
