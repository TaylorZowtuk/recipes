import { expect, type Page, test } from "@playwright/test";

// The local API's fake sign-in and fake web (backend/src/recipes/local.py) aren't on a deployed stack.
test.skip(!!process.env.E2E_BASE_URL, "needs the local API's fake sign-in and fake web");

// Every project shares one local API, and each Source is ingested once, so each test's pages are
// its own: a fresh path on the fake web per test and project.
const pageUrl = (path: string, project: string) => `https://plateful.test/${path}-${project}`;

async function openAddRecipe(page: Page) {
  const signedIn = await page.request.post("/api/session", {
    data: { credential: "fake:editor@example.com" },
  });
  expect(signedIn.ok(), "fake sign-in").toBe(true);
  await page.goto("/add");
  await expect(page.getByRole("heading", { level: 1, name: "Add a recipe" })).toBeVisible();
}

const urlField = (page: Page) => page.getByRole("textbox", { name: "Recipe web address" });

async function fetchRecipe(page: Page, url: string) {
  await urlField(page).fill(url);
  await page.getByRole("button", { name: "Fetch" }).click();
}

const queuedItem = (page: Page, url: string) =>
  page.getByRole("list", { name: "Waiting for the fallback" }).getByRole("listitem").filter({
    hasText: url,
  });

test("an editor adds a recipe from a website and sees it pending in the grid", async ({ page }, {
  project,
}) => {
  const url = pageUrl("lemon-skillet-rice", project.name);
  const title = `Lemon Skillet Rice ${project.name.replace("-", " ")}`.replace(/\b\w/g, (c) =>
    c.toUpperCase(),
  );
  await openAddRecipe(page);
  await fetchRecipe(page, url);

  // The review: the Original as captured, ISO Stated Times humanized and other text as written.
  const review = page.getByRole("main");
  await expect(review.getByRole("heading", { level: 2, name: title })).toBeFocused();
  await expect(review).toContainText("Plateful Test Kitchen");
  await expect(review).toContainText("By Fake Kitchen Cook");
  await expect(review).toContainText(`A synthetic recipe for ${title}`);
  for (const fact of ["Prep15 min", "Cookabout 30 minutes", "Total45 min", "YieldServes 4"]) {
    await expect(review.locator(".facts")).toContainText(fact);
  }
  const ingredients = page.getByRole("tabpanel", { name: "Ingredients" });
  await expect(ingredients.getByRole("listitem")).toHaveText([
    "2 cups cooked rice",
    "1 tbsp olive oil",
    "1 tsp kosher salt",
  ]);
  await page.getByRole("tab", { name: "Steps" }).click();
  await expect(page.getByRole("tabpanel", { name: "Steps" }).getByRole("listitem")).toHaveText([
    "Warm the oil in a pan.",
    "Add the rice and salt, and stir until hot.",
  ]);

  // A partial Difficulty can't be saved; all three can.
  const rate = (part: string, n: string) =>
    page.getByRole("group", { name: part }).getByText(n, { exact: true }).click();
  await rate("Prep", "2");
  await page.getByRole("button", { name: "Save recipe" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Rate all of Prep, Cook and Cleanup, or clear them.",
  );
  await rate("Cook", "3");
  await rate("Cleanup", "1");
  await page.getByRole("textbox", { name: "Tags" }).fill("weeknight, rice");
  await page.getByRole("button", { name: "Save recipe" }).click();

  // The grid has the new recipe without a reload, pending enrichment.
  await expect(page).toHaveURL(/\/recipes$/);
  const card = page
    .getByRole("list", { name: "Recipes" })
    .getByRole("link", { name: new RegExp(title) });
  await expect(card).toContainText("Enrichment pending");
  await expect(card).toContainText("Plateful Test Kitchen");
  await expect(card).toContainText("45 min");

  // Its About tab shows the times as on the review.
  await card.click();
  await page.getByRole("tab", { name: "About" }).click();
  const about = page.getByRole("tabpanel", { name: "About" });
  for (const fact of ["Prep15 min", "Cookabout 30 minutes", "Total45 min"]) {
    await expect(about).toContainText(fact);
  }
  await expect(about.getByRole("link")).toHaveAttribute("href", url);

  // Adding it again links to the recipe already in the Collection.
  await page.goto("/add");
  await fetchRecipe(page, url);
  await expect(page.getByRole("status").filter({ hasText: "already" })).toHaveText(
    "This recipe is already in the Collection. Open it",
  );
  await page.getByRole("link", { name: "Open it" }).click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
});

test("a page that can't be fetched waits for the fallback", async ({ page }, { project }) => {
  const blocked = pageUrl("blocked/turned-away", project.name);
  const robots = pageUrl("robots-denied/no-robots", project.name);
  await openAddRecipe(page);

  await fetchRecipe(page, blocked);
  await expect(page.getByRole("status").filter({ hasText: "fetched" })).toHaveText(
    "The recipe couldn’t be fetched, so it’s waiting for the fallback. It’s in the list below.",
  );
  await expect(urlField(page)).toHaveValue("");
  await expect(queuedItem(page, blocked)).toContainText("plateful.test");
  await expect(queuedItem(page, blocked)).toContainText("The site turned the request away · since");
  await expect(queuedItem(page, blocked).locator(".badge")).toHaveText("Waiting for the fallback");

  await fetchRecipe(page, robots);
  await expect(page.getByRole("status").filter({ hasText: "pasted" })).toContainText(
    "needs its page pasted in later",
  );
  await expect(queuedItem(page, robots)).toContainText("The site doesn’t allow automated fetching");
  await expect(queuedItem(page, robots).locator(".badge")).toHaveText("Needs the page pasted in");

  // It's still there on the next visit, and adding it again says it's already waiting.
  await page.reload();
  await expect(queuedItem(page, blocked)).toBeVisible();
  await fetchRecipe(page, blocked);
  await expect(page.getByRole("status").filter({ hasText: "already" })).toHaveText(
    "This recipe is already waiting for the fallback, in the list below.",
  );
  await expect(queuedItem(page, blocked)).toHaveCount(1);
});

test("a missing page or an invalid address is an inline error", async ({ page }, { project }) => {
  await openAddRecipe(page);
  await fetchRecipe(page, pageUrl("missing/gone", project.name));
  await expect(page.getByRole("alert")).toHaveText(
    "That page isn’t on the site. Check the address and try again.",
  );
  await fetchRecipe(page, "not a web address");
  await expect(page.getByRole("alert")).toHaveText(
    "That isn’t a web address. Paste one that starts with https://.",
  );
  await expect(urlField(page)).toHaveValue("not a web address");
});

test("Add a recipe opens with a fresh form every time", async ({ page }, { project }) => {
  const openFromMenu = async () => {
    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("menuitem", { name: "Add a recipe" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Add a recipe" })).toBeVisible();
  };
  await openAddRecipe(page);

  // Typed in, then left and opened again.
  await urlField(page).fill("https://plateful.test/half-typed");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/recipes$/);
  await openFromMenu();
  await expect(urlField(page)).toHaveValue("");

  // Opened again from the menu while reviewing a recipe, and after an error.
  await fetchRecipe(page, pageUrl("fresh-form-pancakes", project.name));
  await expect(page.getByRole("button", { name: "Save recipe" })).toBeVisible();
  await openFromMenu();
  await expect(urlField(page)).toHaveValue("");
  await fetchRecipe(page, "not a web address");
  await expect(page.getByRole("alert")).toBeVisible();
  await openFromMenu();
  await expect(urlField(page)).toHaveValue("");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("the form is off while offline", async ({ page, context }) => {
  await openAddRecipe(page);
  await context.setOffline(true);
  await expect(urlField(page)).toBeDisabled();
  await expect(page.getByRole("button", { name: "Fetch" })).toBeDisabled();
  await expect(page.getByRole("main")).toContainText(
    "You’re offline. Add a recipe once you’re back online.",
  );
  await context.setOffline(false);
  await expect(urlField(page)).toBeEnabled();
});
