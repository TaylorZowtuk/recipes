import { expect, type Locator, type Page, type TestInfo, test } from "@playwright/test";

// The local API's fake sign-in and fake web (backend/src/recipes/local.py) aren't on a deployed stack.
test.skip(!!process.env.E2E_BASE_URL, "needs the local API's fake sign-in and fake web");

// Every project shares one local API for the whole run, retries and repeats included, and each
// Source is ingested once, so each attempt's pages are its own: a fresh path on the fake web.
const pageUrl = (path: string, { project, retry, repeatEachIndex }: TestInfo) =>
  `https://plateful.test/${path}-${project.name}-r${retry}-e${repeatEachIndex}`;

// The fake web titles a page after its last path segment, as Python's str.title() does.
const titleOf = (url: string) =>
  (url.split("/").pop() ?? "")
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");

async function signIn(page: Page) {
  const signedIn = await page.request.post("/api/session", {
    data: { credential: "fake:editor@example.com" },
  });
  expect(signedIn.ok(), "fake sign-in").toBe(true);
}

async function openAddRecipe(page: Page) {
  await signIn(page);
  await page.goto("/add");
  await expect(page.getByRole("heading", { level: 1, name: "Add a recipe" })).toBeVisible();
}

async function openFromMenu(page: Page) {
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Add a recipe" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Add a recipe" })).toBeVisible();
}

// Opens the grid first, so this page load holds the Collection in memory, then Add a recipe from
// the menu, so a save has to make the grid load the new version.
async function openAddRecipeFromGrid(page: Page) {
  await signIn(page);
  await page.goto("/recipes");
  await expect(page.getByRole("list", { name: "Recipes" })).toBeVisible();
  await openFromMenu(page);
}

const syncStatus = (page: Page) => page.locator(".sync-status");

async function collectionVersion(page: Page) {
  await expect(syncStatus(page)).toHaveText(/collection v\d+$/);
  return Number((await syncStatus(page).textContent())?.match(/v(\d+)$/)?.[1]);
}

// Saves a recipe from another device, as far as this page load knows.
async function saveElsewhere(page: Page, url: string) {
  const ingested = await page.request.post("/api/ingest", { data: { url } });
  expect(ingested.status(), "ingest").toBe(200);
  const { source, original } = await ingested.json();
  const saved = await page.request.post("/api/recipes", {
    data: { source, original, difficulty: null, tags: [] },
  });
  expect(saved.status(), "save").toBe(201);
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

test("an editor adds a recipe from a website and sees it pending in the grid", async ({
  page,
}, testInfo) => {
  const url = pageUrl("lemon-skillet-rice", testInfo);
  const title = titleOf(url);
  await openAddRecipeFromGrid(page);
  const before = await collectionVersion(page);
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
  await expect.poll(() => collectionVersion(page)).toBeGreaterThan(before);

  // Its About tab shows the times as on the review.
  await card.click();
  await page.getByRole("tab", { name: "About" }).click();
  const about = page.getByRole("tabpanel", { name: "About" });
  for (const fact of ["Prep15 min", "Cookabout 30 minutes", "Total45 min"]) {
    await expect(about).toContainText(fact);
  }
  await expect(about.getByRole("link")).toHaveAttribute("href", url);
});

const photoPicker = (page: Page) => page.getByRole("group", { name: "Photo" });

// Clicks the label: the radio itself is visually hidden behind its swatch.
const pickPhoto = (page: Page, name: string) =>
  photoPicker(page)
    .locator("label", { has: page.getByRole("radio", { name, exact: true }) })
    .click();

const plateImage = (plate: Locator) => plate.locator(".plate img");
const objectPositionOf = (image: Locator) =>
  image.evaluate((img) => (img as HTMLImageElement).style.objectPosition);

test("an editor picks a Preview Photo and drags its Focal Point, and the card and header show it", async ({
  page,
}, testInfo) => {
  const url = pageUrl("photo-herb-omelette", testInfo);
  const title = titleOf(url);
  await openAddRecipeFromGrid(page);
  await fetchRecipe(page, url);

  // The candidates store, and the first is the Preview Photo, centred, in the hero plate.
  await expect(photoPicker(page).getByRole("status")).toHaveText("3 photos");
  await expect(photoPicker(page).getByRole("radio")).toHaveCount(4);
  await expect(page.getByRole("radio", { name: "Photo 1" })).toBeChecked();
  const preview = plateImage(page.locator(".review .hero"));
  await expect(preview).toHaveCSS("object-position", "50% 50%");

  // Another is picked, and its Focal Point dragged towards the top left, then nudged right.
  await pickPhoto(page, "Photo 3");
  await expect(page.getByRole("radio", { name: "Photo 3" })).toBeChecked();
  const focal = page.getByRole("slider", { name: "Focal Point" });
  await focal.scrollIntoViewIfNeeded();
  const box = await focal.boundingBox();
  if (!box) throw new Error("no Focal Point picker");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3, { steps: 5 });

  // Mid-drag, the small plate beside the photo shows the round crop, in view with the photo.
  const crop = plateImage(page.locator(".focal"));
  await expect(crop).not.toHaveCSS("object-position", "50% 50%");
  await expect(crop).toBeInViewport({ ratio: 1 });
  await page.mouse.up();
  await expect(focal).toHaveAttribute("aria-valuetext", /^(19|20|21)% across, (29|30|31)% down$/);
  // A step is 5%, give or take the rounding of the dragged position.
  const across = async () => Number(await focal.getAttribute("aria-valuenow"));
  const dragged = await across();
  await focal.press("ArrowRight");
  await expect.poll(across).not.toBe(dragged);
  expect(Math.abs((await across()) - (dragged + 5))).toBeLessThanOrEqual(1);
  const position = await objectPositionOf(preview);
  expect(position).not.toBe("50% 50%");
  await expect(preview).toHaveCSS("object-position", position);
  expect(await objectPositionOf(crop)).toBe(position);

  await page.getByRole("button", { name: "Save recipe" }).click();

  // The card shows the card-size copy, and the header the full one, both about that Focal Point.
  await expect(page).toHaveURL(/\/recipes$/);
  const card = page
    .getByRole("list", { name: "Recipes" })
    .getByRole("link", { name: new RegExp(title) });
  await expect(plateImage(card)).toHaveAttribute("src", /^\/images\/[0-9a-f]+-card\.webp$/);
  expect(await objectPositionOf(plateImage(card))).toBe(position);
  await card.click();
  const header = plateImage(page.locator(".hero"));
  await expect(header).toHaveAttribute("src", /^\/images\/[0-9a-f]+\.webp$/);
  expect(await objectPositionOf(header)).toBe(position);
  await expect(header).toHaveJSProperty("complete", true);
  expect(await header.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
});

test("a recipe saved with No photo shows the Empty Plate", async ({ page }, testInfo) => {
  const url = pageUrl("photo-less-porridge", testInfo);
  const title = titleOf(url);
  await openAddRecipe(page);
  await fetchRecipe(page, url);
  await expect(photoPicker(page).getByRole("status")).toHaveText("3 photos");

  await pickPhoto(page, "No photo");
  await expect(page.getByRole("radio", { name: "No photo" })).toBeChecked();
  const hero = page.locator(".review .hero .plate");
  await expect(hero.locator("img")).toHaveCount(0);
  await expect(hero).toHaveText("P");
  await expect(page.getByRole("slider", { name: "Focal Point" })).toHaveCount(0);
  await page.getByRole("button", { name: "Save recipe" }).click();

  await expect(page).toHaveURL(/\/recipes$/);
  const card = page
    .getByRole("list", { name: "Recipes" })
    .getByRole("link", { name: new RegExp(title) });
  await expect(card.locator(".plate-initial")).toHaveText("P");
  await expect(plateImage(card)).toHaveCount(0);
});

test("a recipe already in the Collection links to it, though this page load hasn't seen it", async ({
  page,
}, testInfo) => {
  const fetched = pageUrl("saved-elsewhere-soup", testInfo);
  const reviewed = pageUrl("saved-while-reviewing-stew", testInfo);
  await openAddRecipeFromGrid(page);

  // Fetching it again.
  await saveElsewhere(page, fetched);
  await fetchRecipe(page, fetched);
  await expect(page.getByRole("status").filter({ hasText: "already" })).toHaveText(
    "This recipe is already in the Collection. Open it",
  );
  await page.getByRole("link", { name: "Open it" }).click();
  await expect(page.getByRole("heading", { level: 1, name: titleOf(fetched) })).toBeVisible();

  // Saved by someone else while this editor reviews it.
  await openFromMenu(page);
  await fetchRecipe(page, reviewed);
  await expect(page.getByRole("button", { name: "Save recipe" })).toBeVisible();
  await saveElsewhere(page, reviewed);
  await page.getByRole("button", { name: "Save recipe" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "This recipe is already in the Collection. Open it",
  );
  await page.getByRole("link", { name: "Open it" }).click();
  await expect(page.getByRole("heading", { level: 1, name: titleOf(reviewed) })).toBeVisible();
});

test("a page that can't be fetched waits for the fallback", async ({ page }, testInfo) => {
  const blocked = pageUrl("blocked/turned-away", testInfo);
  const robots = pageUrl("robots-denied/no-robots", testInfo);
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

test("a missing page or an invalid address is an inline error", async ({ page }, testInfo) => {
  await openAddRecipe(page);
  await fetchRecipe(page, pageUrl("missing/gone", testInfo));
  await expect(page.getByRole("alert")).toHaveText(
    "That page isn’t on the site. Check the address and try again.",
  );
  await fetchRecipe(page, "not a web address");
  await expect(page.getByRole("alert")).toHaveText(
    "That isn’t a web address. Paste one that starts with https://.",
  );
  await expect(urlField(page)).toHaveValue("not a web address");
});

test("Add a recipe opens with a fresh form every time", async ({ page }, testInfo) => {
  await openAddRecipe(page);

  // Typed in, then left and opened again.
  await urlField(page).fill("https://plateful.test/half-typed");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/recipes$/);
  await openFromMenu(page);
  await expect(urlField(page)).toHaveValue("");

  // Opened again from the menu while reviewing a recipe, and after an error.
  await fetchRecipe(page, pageUrl("fresh-form-pancakes", testInfo));
  await expect(page.getByRole("button", { name: "Save recipe" })).toBeVisible();
  await openFromMenu(page);
  await expect(urlField(page)).toHaveValue("");
  await fetchRecipe(page, "not a web address");
  await expect(page.getByRole("alert")).toBeVisible();
  await openFromMenu(page);
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

test("the Waiting list says it isn't available offline, and loads once back", async ({
  page,
  context,
}) => {
  const waiting = page.getByRole("region", { name: "Waiting for the fallback" });
  await openAddRecipe(page);
  await expect(waiting.getByRole("status")).not.toHaveText("Loading…");
  await context.setOffline(true);
  await openFromMenu(page);
  await expect(waiting.getByRole("status")).toHaveText("The list isn’t available offline.");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await context.setOffline(false);
  await expect(waiting.getByRole("status")).not.toHaveText(/offline|Loading/);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test.describe("while a Candidate Photo stores", () => {
  // In WebKit, page.route stops seeing requests once a service worker registers.
  test.use({ serviceWorkers: "block" });

  test("Save waits until every candidate has stored, and keeps them all", async ({
    page,
  }, testInfo) => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    await page.route("**/api/images", async (route) => {
      if (first) {
        first = false;
        await held;
      }
      await route.continue();
    });
    await openAddRecipe(page);
    await fetchRecipe(page, pageUrl("photo-slow-frittata", testInfo));

    // Two have stored and one is still storing: Save is off, even with No photo chosen.
    const save = page.getByRole("button", { name: "Save recipe" });
    await expect(page.getByRole("radio", { name: "Photo 2" })).toBeAttached();
    await expect(save).toBeDisabled();
    await expect(page.locator(".review-form").getByRole("status")).toHaveText(
      "Save waits until the photos are in.",
    );
    await pickPhoto(page, "No photo");
    await expect(save).toBeDisabled();

    release();
    await expect(save).toBeEnabled();
    await expect(page.locator(".review-form").getByRole("status")).toHaveText("");
    const saved = page.waitForRequest("**/api/recipes");
    await save.click();
    const body = (await saved).postDataJSON();
    expect(body.images).toHaveLength(3);
    expect(body.preview).toBeNull();
    await expect(page).toHaveURL(/\/recipes$/);
  });

  test("No photo chosen while the candidates store stays chosen once they settle", async ({
    page,
  }, testInfo) => {
    const url = pageUrl("photo-early-choice-congee", testInfo);
    const title = titleOf(url);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/images", async (route) => {
      await held;
      await route.continue();
    });
    await openAddRecipe(page);
    await fetchRecipe(page, url);

    // Nothing has stored, so nothing is chosen yet; then the editor chooses No photo.
    await expect(photoPicker(page).getByRole("status")).toHaveText("Getting the photos…");
    const none = page.getByRole("radio", { name: "No photo" });
    await expect(none).not.toBeChecked();
    await pickPhoto(page, "No photo");

    release();
    await expect(photoPicker(page).getByRole("status")).toHaveText("3 photos");
    await expect(none).toBeChecked();
    await page.getByRole("button", { name: "Save recipe" }).click();

    await expect(page).toHaveURL(/\/recipes$/);
    const card = page
      .getByRole("list", { name: "Recipes" })
      .getByRole("link", { name: new RegExp(title) });
    await expect(card.locator(".plate-initial")).toHaveText("P");
    await expect(plateImage(card)).toHaveCount(0);
  });

  test("a candidate the busy API turns away with a 429 is tried again and stores", async ({
    page,
  }, testInfo) => {
    let turnedAway: string | undefined;
    await page.route("**/api/images", async (route) => {
      const { url } = route.request().postDataJSON();
      if (turnedAway !== undefined) return route.continue();
      turnedAway = url;
      return route.fulfill({ status: 429, json: { message: "Rate exceeded." } });
    });
    await openAddRecipe(page);
    await fetchRecipe(page, pageUrl("photo-busy-paella", testInfo));

    await expect(photoPicker(page).getByRole("status")).toHaveText("3 photos");
    await expect(photoPicker(page).getByRole("radio", { name: /^Photo \d$/ })).toHaveCount(3);
    expect(turnedAway).toBeDefined();
  });
});

test.describe("while Plateful updates", () => {
  // In WebKit, page.route stops seeing requests once a service worker registers.
  test.use({ serviceWorkers: "block" });

  test("the form is paused, as offline", async ({ page }) => {
    await page.route("**/api/sync", async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        json: { ...(await response.json()), read_only: "updating" },
      });
    });
    await openAddRecipe(page);
    await expect(urlField(page)).toBeDisabled();
    await expect(page.getByRole("main")).toContainText("Editing is paused while Plateful updates.");
  });
});
