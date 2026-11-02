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
  // The grid's own items, not the Tags listed inside a card.
  const items = grid(page).locator(":scope > li");
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

  // Ingredients first, under their Component headings: each line's name, preparation and remark
  // on the left and its amount right-aligned, with kitchen fractions and ranges.
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
  const lines = panel.getByRole("listitem");
  await expect(lines).toHaveCount(9);
  await expect(lines.locator(".ingredient-amount")).toHaveText([
    "3 tbsp",
    "2 tbsp",
    "1½ tbsp",
    "1 tsp",
    "400 g",
    "2 tbsp",
    "3 tbsp",
    "250 g",
    "1–2",
  ]);
  await expect(lines.nth(3).locator(".ingredient-name")).toHaveText("chili oil, or to taste");
  const tofu = lines.nth(4);
  await expect(tofu.locator(".ingredient-name")).toHaveText("firm tofu, cubed");
  const line = await tofu.boundingBox();
  const name = await tofu.locator(".ingredient-name").boundingBox();
  const amount = await tofu.locator(".ingredient-amount").boundingBox();
  expect(name!.x).toBeLessThan(line!.x + 1);
  expect(amount!.x).toBeGreaterThan(name!.x + name!.width);
  expect(amount!.x + amount!.width).toBeCloseTo(line!.x + line!.width, 0);

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
  await expect(panel.getByRole("list").nth(1)).toHaveAttribute("start", "2");
  // A step that names an ingredient line shows the amount it uses: half the green onions here,
  // and the rest in the next step. One with no segments shows its text as captured.
  const steps = panel.getByRole("listitem");
  await expect(steps.nth(0)).toHaveText("Whisk the sauce ingredients with 2 tbsp warm water.");
  await expect(steps.nth(0).locator(".step-amount")).toHaveCount(0);
  await expect(steps.nth(1)).toHaveText("Toss 400 g firm tofu in 2 tbsp cornstarch.");
  await expect(steps.nth(3).locator(".step-amount")).toHaveText(["250 g", "½–1"]);
  await expect(steps.nth(4).locator(".step-amount")).toHaveText(["½–1"]);
  await expect(steps.nth(4)).toContainText("top with the tofu and ½–1 green onions.");

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

test("filter the Collection by Tag, Total Difficulty, Cleanup and Stated Time", async ({
  page,
}) => {
  await page.goto("/recipes");
  await shownCount(page);
  const seededTitles = () => seededCards(page).locator(".card-title");

  // A row of the Collection's Tags, one tap each, that scrolls sideways rather than wrapping.
  const chips = page.getByRole("list", { name: "Filter by Tag" });
  const weeknight = chips.getByRole("button", { name: "weeknight", exact: true });
  await expect(weeknight).toHaveAttribute("aria-pressed", "false");
  await expectTapTarget(weeknight);
  const row = await chips.evaluate((list) => ({
    style: getComputedStyle(list).overflowX,
    tops: new Set([...list.children].map((chip) => chip.getBoundingClientRect().top)).size,
  }));
  expect(row.style).toBe("auto");
  expect(row.tops).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth),
  );

  await weeknight.click();
  await expect(weeknight).toHaveAttribute("aria-pressed", "true");
  await expect(seededTitles()).toHaveText([recipeTitle, "Tomato Lentil Soup"]);
  const filters = page.getByRole("button", { name: /^Filters/ });
  await expect(filters).toHaveText("Filters · 1");
  await expectTapTarget(filters);

  // The sheet shares the chosen Tags, and a second one must also match.
  await filters.click();
  const sheet = page.getByRole("dialog", { name: "Filters" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "Filters" })).toBeFocused();
  await expect(sheet.getByRole("button", { name: "weeknight", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const vegetarian = sheet.getByRole("button", { name: "vegetarian", exact: true });
  await expectTapTarget(vegetarian);
  await vegetarian.click();
  await expect(seededTitles()).toHaveText([recipeTitle]);
  await expect(filters).toHaveText("Filters · 2");

  // The sheet covers the status line, so its Done button carries the live count.
  const done = sheet.getByRole("button", { name: /^(Show \d+ recipes?|No recipes match)$/ });
  await expect(done).toHaveText("Show 1 recipe");
  await expect(sheet.getByRole("status")).toHaveText("Show 1 recipe");

  // Clear empties every filter, the chip row's too.
  await sheet.getByRole("button", { name: "Clear" }).click();
  await expect(seededCards(page)).toHaveCount(seededCount);
  await expect(filters).toHaveText("Filters");
  await expect(weeknight).toHaveAttribute("aria-pressed", "false");

  // A maximum Total Difficulty, then easy cleanup, each drop the cards without a Difficulty.
  const difficulty = sheet.getByRole("group", { name: "Total Difficulty at most" });
  await expect(difficulty.getByRole("radio", { name: "Any" })).toBeChecked();
  await expectTapTarget(difficulty.locator("label").filter({ hasText: "4" }));
  await difficulty.getByText("4", { exact: true }).click();
  await expect(seededTitles()).toHaveText(["Garlic Butter Green Beans", "Overnight Oats"]);
  await difficulty.getByText("Any", { exact: true }).click();
  await expect(seededCards(page)).toHaveCount(seededCount);

  const cleanup = sheet.getByRole("checkbox", { name: "Easy cleanup" });
  const cleanupLabel = sheet.locator("label", { hasText: "Easy cleanup" });
  await expectTapTarget(cleanupLabel);
  await cleanupLabel.click();
  await expect(cleanup).toBeChecked();
  await expect(seededTitles()).toHaveText(["Garlic Butter Green Beans", "Overnight Oats"]);
  await cleanupLabel.click();

  // A maximum Stated Time drops the cards without one.
  const time = sheet.getByRole("group", { name: "Stated Time at most" });
  await time.getByText("30 min", { exact: true }).click();
  await expect(seededTitles()).toHaveText(["Garlic Butter Green Beans", recipeTitle]);
  await expect(filters).toHaveText("Filters · 1");
  await expect(done).toHaveText(/^Show \d+ recipes$/);

  // Done closes the sheet and returns focus to the Filters button; the filters stay.
  await expectTapTarget(done);
  await expectTapTarget(sheet.getByRole("button", { name: "Clear" }));
  await done.click();
  await expect(sheet).toBeHidden();
  await expect(filters).toBeFocused();
  await expect(seededTitles()).toHaveText(["Garlic Butter Green Beans", recipeTitle]);

  // A tap in the sheet's own margin, beside a pill, leaves it open; Escape closes it.
  await filters.click();
  const box = await sheet.boundingBox();
  const any = difficulty.getByText("Any", { exact: true });
  await any.scrollIntoViewIfNeeded();
  const pill = await any.boundingBox();
  if (!box || !pill) throw new Error("The sheet isn't laid out");
  await page.mouse.click(box.x + 4, pill.y + pill.height / 2);
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(filters).toBeFocused();

  // A tap on the backdrop, outside the sheet, closes it.
  await filters.click();
  await page.mouse.click(4, 4);
  await expect(sheet).toBeHidden();
  await expect(filters).toBeFocused();

  // Nothing matching says so, with the search too.
  await weeknight.click();
  await chips.getByRole("button", { name: "breakfast", exact: true }).click();
  await filters.click();
  await expect(done).toHaveText("No recipes match");
  await done.click();
  await expect(sheet).toBeHidden();
  await expect(resultCount(page)).toHaveText("No recipes match these filters.");
  await page.getByRole("searchbox", { name: "Search recipe titles" }).fill("oats");
  await expect(resultCount(page)).toHaveText("No recipes match “oats” and these filters.");
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
    await page.route("**/api/v/collection/*", (route) => {
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
    ["Collection", "**/api/v/collection/*"],
    ["recipe", `**/api/v/recipes/${recipeId}/**`],
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
