import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";

// The local API's fake sign-in and fake web (backend/src/recipes/local.py) aren't on a deployed stack.
test.skip(!!process.env.E2E_BASE_URL, "needs the local API's fake sign-in and fake web");

// In WebKit, page.route stops seeing requests once a service worker registers.
test.use({ serviceWorkers: "block" });

// Every project shares one local API, so each test edits a recipe of its own, never a seed one.
const pageUrl = (path: string, { project, retry, repeatEachIndex }: TestInfo) =>
  `https://plateful.test/${path}-${project.name}-r${retry}-e${repeatEachIndex}`;

type Saved = { id: string; version: number; original: { title: string } };

async function signIn(api: APIRequestContext) {
  const signedIn = await api.post("/api/session", {
    data: { credential: "fake:editor@example.com" },
  });
  expect(signedIn.ok(), "fake sign-in").toBe(true);
}

// Adds a recipe through the API, rated 1, 1, 1 and tagged "weeknight".
async function addRecipe(api: APIRequestContext, url: string): Promise<Saved> {
  const ingested = await api.post("/api/ingest", { data: { url } });
  expect(ingested.status(), "ingest").toBe(200);
  const { source, original } = await ingested.json();
  const saved = await api.post("/api/recipes", {
    data: {
      source,
      original,
      difficulty: { prep: 1, cook: 1, cleanup: 1 },
      tags: ["weeknight"],
    },
  });
  expect(saved.status(), "save").toBe(201);
  return saved.json();
}

// Adds a recipe with the page's first two photos stored, the first its Preview Photo.
async function addRecipeWithPhotos(api: APIRequestContext, url: string): Promise<Saved> {
  const ingested = await api.post("/api/ingest", { data: { url } });
  expect(ingested.status(), "ingest").toBe(200);
  const { source, original, candidate_photos } = await ingested.json();
  const images = [];
  for (const photo of (candidate_photos as string[]).slice(0, 2)) {
    const stored = await api.post("/api/images", { data: { url: photo } });
    expect(stored.status(), "store photo").toBe(200);
    images.push(await stored.json());
  }
  expect(images, "two stored photos").toHaveLength(2);
  const saved = await api.post("/api/recipes", {
    data: {
      source,
      original,
      tags: [],
      images,
      preview: { image_id: images[0].id, focal_x: 0.5, focal_y: 0.5 },
    },
  });
  expect(saved.status(), "save").toBe(201);
  return saved.json();
}

async function openRecipe(page: Page, recipe: Saved) {
  await page.goto(`/recipes/${recipe.id}`);
  await expect(page.getByRole("heading", { level: 1, name: recipe.original.title })).toBeVisible();
}

async function editorOpens(page: Page, testInfo: TestInfo, path: string) {
  await signIn(page.request);
  const recipe = await addRecipe(page.request, pageUrl(path, testInfo));
  await openRecipe(page, recipe);
  return recipe;
}

const hero = (page: Page) => page.locator(".hero");
const difficulty = (scope: ReturnType<Page["locator"]>) => scope.getByLabel(/^Difficulty:/);
const tags = (scope: ReturnType<Page["locator"]>) => scope.getByRole("list", { name: "Tags" });
const rate = (page: Page, part: string, n: string) =>
  page.getByRole("group", { name: part }).getByText(n, { exact: true }).click();
const tagsField = (page: Page) => page.getByRole("textbox", { name: "Tags" });
const ONE_ONE_ONE = "Difficulty: Prep 1 of 3, Cook 1 of 3, Cleanup 1 of 3, total 3 of 9";

async function expectUnchanged(page: Page) {
  await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();
  await expect(tagsField(page)).toHaveCount(0);
  await expect(difficulty(hero(page))).toHaveAttribute("aria-label", ONE_ONE_ONE);
  await expect(tags(hero(page)).getByRole("listitem")).toHaveText(["weeknight"]);
}

test("an editor edits Difficulty and Tags in one save, and the card shows them", async ({
  page,
}, testInfo) => {
  const recipe = await editorOpens(page, testInfo, "edit-saves");
  await page.getByRole("button", { name: "Edit" }).click();
  // The Edit button that had focus is gone, so focus moves to the form's heading.
  await expect(page.getByRole("heading", { name: "Edit recipe" })).toBeFocused();
  const save = page.getByRole("button", { name: /^Save \d+ changes?$/ });
  await expect(save).toHaveText("Save 0 changes");
  await expect(save).toBeDisabled();

  await rate(page, "Cook", "3");
  await expect(save).toHaveText("Save 1 change");
  await tagsField(page).fill("weeknight, rice");
  await expect(save).toHaveText("Save 2 changes");
  await save.click();

  await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();
  await expect(tagsField(page)).toHaveCount(0);
  await expect(difficulty(hero(page))).toHaveAttribute(
    "aria-label",
    "Difficulty: Prep 1 of 3, Cook 3 of 3, Cleanup 1 of 3, total 5 of 9",
  );
  await expect(tags(hero(page)).getByRole("listitem")).toHaveText(["weeknight", "rice"]);

  await page.getByRole("button", { name: "Back" }).click();
  const card = page
    .getByRole("list", { name: "Recipes" })
    .getByRole("link")
    .filter({ hasText: recipe.original.title });
  await expect(difficulty(card)).toHaveAttribute(
    "aria-label",
    "Difficulty: Prep 1 of 3, Cook 3 of 3, Cleanup 1 of 3, total 5 of 9",
  );
  await expect(tags(card).getByRole("listitem")).toHaveText(["weeknight", "rice"]);
});

test("a save whose Collection reload fails keeps the recipe on screen and says to reload", async ({
  page,
}, testInfo) => {
  const recipe = await editorOpens(page, testInfo, "edit-reload-fails");
  await page.getByRole("button", { name: "Edit" }).click();
  await tagsField(page).fill("weeknight, rice");
  await page.route("**/api/v/collection/**", (route) => route.abort());
  await page.getByRole("button", { name: "Save 1 change" }).click();

  await expect(page.getByRole("alert")).toHaveText(
    "Saved, but couldn’t refresh. Reload to see the latest.",
  );
  await expect(page.getByRole("alert")).toBeFocused();
  await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: recipe.original.title })).toBeVisible();
});

test("Cancel discards the draft", async ({ page }, testInfo) => {
  await editorOpens(page, testInfo, "edit-cancels");
  await page.getByRole("button", { name: "Edit" }).click();
  await rate(page, "Prep", "2");
  await tagsField(page).fill("soup");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expectUnchanged(page);

  // Edit opens afresh from the recipe, not the discarded draft.
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(tagsField(page)).toHaveValue("weeknight");
});

test("leaving the page discards the draft", async ({ page }, testInfo) => {
  const recipe = await editorOpens(page, testInfo, "edit-leaves");
  await page.getByRole("button", { name: "Edit" }).click();
  await tagsField(page).fill("soup");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("list", { name: "Recipes" })).toBeVisible();
  await page
    .getByRole("list", { name: "Recipes" })
    .getByRole("link")
    .filter({ hasText: recipe.original.title })
    .click();
  await expectUnchanged(page);
});

test("a save that lost a race shows the newer recipe and says so", async ({ page }, testInfo) => {
  const recipe = await editorOpens(page, testInfo, "edit-conflicts");
  await page.getByRole("button", { name: "Edit" }).click();
  await tagsField(page).fill("soup");

  // Another device saves first.
  const elsewhere = await page.request.patch(`/api/recipes/${recipe.id}`, {
    data: { version: recipe.version, operations: [{ op: "set_tags", tags: ["from elsewhere"] }] },
  });
  expect(elsewhere.status(), "patch elsewhere").toBe(200);

  await page.getByRole("button", { name: "Save 1 change" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "This recipe changed on another device. Showing the newer version.",
  );
  await expect(page.getByRole("alert")).toBeFocused();
  await expect(tagsField(page)).toHaveCount(0);
  await expect(tags(hero(page)).getByRole("listitem")).toHaveText(["from elsewhere"]);
});

test("a save that lost a race, then couldn't reload, says to reload", async ({
  page,
}, testInfo) => {
  const recipe = await editorOpens(page, testInfo, "edit-conflict-reload-fails");
  await page.getByRole("button", { name: "Edit" }).click();
  await tagsField(page).fill("soup");

  const elsewhere = await page.request.patch(`/api/recipes/${recipe.id}`, {
    data: { version: recipe.version, operations: [{ op: "set_tags", tags: ["from elsewhere"] }] },
  });
  expect(elsewhere.status(), "patch elsewhere").toBe(200);
  await page.route("**/api/v/collection/**", (route) => route.abort());

  await page.getByRole("button", { name: "Save 1 change" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "This recipe changed on another device, but couldn’t refresh. Reload to see the newer version.",
  );
  await expect(page.getByRole("alert")).toBeFocused();
  await expect(tagsField(page)).toHaveCount(0);
});

test("a delete that lost a race shows the newer recipe and says so", async ({ page }, testInfo) => {
  const recipe = await editorOpens(page, testInfo, "edit-delete-conflicts");
  await page.getByRole("button", { name: "Edit" }).click();

  // Another device saves first.
  const elsewhere = await page.request.patch(`/api/recipes/${recipe.id}`, {
    data: { version: recipe.version, operations: [{ op: "set_tags", tags: ["from elsewhere"] }] },
  });
  expect(elsewhere.status(), "patch elsewhere").toBe(200);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete recipe" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "This recipe changed on another device. Showing the newer version.",
  );
  await expect(page.getByRole("alert")).toBeFocused();
  await expect(tagsField(page)).toHaveCount(0);
  await expect(tags(hero(page)).getByRole("listitem")).toHaveText(["from elsewhere"]);
  await expect(page).toHaveURL(new RegExp(`/recipes/${recipe.id}/`));
});

test("a save after another device deleted the recipe says it's gone", async ({
  page,
}, testInfo) => {
  const recipe = await editorOpens(page, testInfo, "edit-deleted-elsewhere");
  await page.getByRole("button", { name: "Edit" }).click();
  await tagsField(page).fill("soup");

  const elsewhere = await page.request.delete(`/api/recipes/${recipe.id}`, {
    params: { version: recipe.version },
  });
  expect(elsewhere.status(), "delete elsewhere").toBe(204);

  await page.getByRole("button", { name: "Save 1 change" }).click();
  await expect(page.getByRole("alert")).toHaveText("This recipe was deleted on another device.");
  await expect(page.getByRole("alert")).toBeFocused();
  await expect(page.getByRole("heading", { level: 1, name: "Recipe not found" })).toBeVisible();
  // The notice says why, so the not-found page's own note doesn't repeat it.
  await expect(page.getByText("There’s no recipe at this address.")).toHaveCount(0);
  await expect(tagsField(page)).toHaveCount(0);
});

test("an editor deletes a recipe and it leaves the Collection", async ({ page }, testInfo) => {
  const recipe = await editorOpens(page, testInfo, "edit-deletes");
  await page.getByRole("button", { name: "Edit" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete recipe" }).click();
  // A delete rewrites the Collection, which on the run's one busy local API can take seconds.
  await expect(page).toHaveURL(/\/recipes$/, { timeout: 15_000 });
  const grid = page.getByRole("list", { name: "Recipes" });
  await expect(grid.getByRole("link").first()).toBeVisible();
  await expect(grid.getByRole("link").filter({ hasText: recipe.original.title })).toHaveCount(0);
});

test("Delete asks first, and keeps the recipe when declined", async ({ page }, testInfo) => {
  await editorOpens(page, testInfo, "edit-keeps");
  await page.getByRole("button", { name: "Edit" }).click();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Delete recipe" }).click();
  await expect(page.getByRole("button", { name: "Save 0 changes" })).toBeVisible();
});

test("Edit is off while offline", async ({ page, context }, testInfo) => {
  await editorOpens(page, testInfo, "edit-offline");
  await context.setOffline(true);
  await expect(page.getByRole("button", { name: "Edit" })).toBeDisabled();
  await expect(page.getByRole("main")).toContainText(
    "You’re offline. Edit the recipe once you’re back online.",
  );
  await context.setOffline(false);
  await expect(page.getByRole("button", { name: "Edit" })).toBeEnabled();
});

test("a visitor sees Difficulty and Tags with no Edit", async ({ page, request }, testInfo) => {
  // The editor adds it through the separate request context, so this page stays a visitor's.
  await signIn(request);
  const recipe = await addRecipe(request, pageUrl("edit-visitor", testInfo));

  await openRecipe(page, recipe);
  await expect(difficulty(hero(page))).toHaveAttribute("aria-label", ONE_ONE_ONE);
  await expect(tags(hero(page)).getByRole("listitem")).toHaveText(["weeknight"]);
  await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
});

test("an editor changes the Preview Photo and Focal Point, and the header and card show them", async ({
  page,
}, testInfo) => {
  await signIn(page.request);
  const recipe = await addRecipeWithPhotos(page.request, pageUrl("edit-photo", testInfo));
  await openRecipe(page, recipe);
  const plateImage = (scope: Locator) => scope.locator(".plate img");
  const objectPositionOf = (image: Locator) =>
    image.evaluate((img) => (img as HTMLImageElement).style.objectPosition);
  const header = plateImage(hero(page));
  await expect(header).toHaveAttribute("src", /^\/images\/[0-9a-f]+\.webp$/);
  const before = await header.getAttribute("src");

  await page.getByRole("button", { name: "Edit" }).click();
  const picker = page.getByRole("group", { name: "Photo" });
  await expect(picker.getByRole("radio", { name: "Photo 1" })).toBeChecked();
  const save = page.getByRole("button", { name: /^Save \d+ changes?$/ });
  await expect(save).toHaveText("Save 0 changes");
  // Clicks the label: the radio itself is visually hidden behind its swatch.
  await picker
    .locator("label", { has: page.getByRole("radio", { name: "Photo 2", exact: true }) })
    .click();
  await expect(save).toHaveText("Save 1 change");
  const focal = page.getByRole("slider", { name: "Focal Point" });
  await focal.focus();
  await focal.press("ArrowLeft");
  await focal.press("ArrowUp");
  await expect(save).toHaveText("Save 1 change");
  await save.click();

  await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();
  await expect(header).not.toHaveAttribute("src", before ?? "");
  await expect(header).toHaveAttribute("src", /^\/images\/[0-9a-f]+\.webp$/);
  const position = await objectPositionOf(header);
  expect(position).not.toBe("50% 50%");

  await page.getByRole("button", { name: "Back" }).click();
  const card = page
    .getByRole("list", { name: "Recipes" })
    .getByRole("link")
    .filter({ hasText: recipe.original.title });
  const cardImage = plateImage(card);
  await expect(cardImage).toHaveAttribute("src", /^\/images\/[0-9a-f]+-card\.webp$/);
  expect(await cardImage.getAttribute("src")).not.toBe(before?.replace(".webp", "-card.webp"));
  expect(await objectPositionOf(cardImage)).toBe(position);
});
