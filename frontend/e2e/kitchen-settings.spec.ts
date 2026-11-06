import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";

// The local API's fake sign-in isn't on a deployed stack.
test.skip(!!process.env.E2E_BASE_URL, "needs the local API's fake sign-in");

// In WebKit, page.route stops seeing requests once a service worker registers.
test.use({ serviceWorkers: "block" });

// A test can end with a stubbed bundle in flight, whose response goes as the page closes.
test.afterEach(({ page }) => page.unrouteAll({ behavior: "ignoreErrors" }));

// The Kitchen settings are one item on the run's one API, so a project's save would be another's
// 409. So each test here gets a list of its own through `stubKitchen`, which covers the page in
// every browser. What only the real API shows is tested by the "real API" tests, in one project
// only, WebKit's, so a drag reaches the API there, and they leave the seed as they found it.
const REAL_API_PROJECT = "iphone-light";

type Category = { id: string; name: string };
type Ingredient = {
  id: string;
  name: string;
  store_category_id: string;
  pantry_staple: boolean;
  version: number;
};
type Operation = { op: string; [field: string]: unknown };
type Edit = { version: number; operations: Operation[] };

const AISLES: Category = { id: "aisles", name: "Aisles" };
const BAKERY: Category = { id: "bakery", name: "Bakery" };
const CHILLED: Category = { id: "chilled", name: "Chilled" };
const DELI: Category = { id: "deli", name: "Deli" };
const ingredientId = (n: number) => `01K7E2E${"0".repeat(18)}${n}`;
const ingredient = (n: number, name: string, category: Category, staple = false): Ingredient => ({
  id: ingredientId(n),
  name,
  store_category_id: category.id,
  pantry_staple: staple,
  version: 1,
});
const RYE = ingredient(1, "rye flour", AISLES);
const SALT = ingredient(2, "flaky salt", AISLES, true);
const LOAF = ingredient(3, "bread loaf", BAKERY);
const CREAM = ingredient(4, "double cream", CHILLED);
const INGREDIENTS = [RYE, SALT, LOAF, CREAM];

// What `PATCH /api/kitchen-settings` does to the stub's list.
function applied(categories: Category[], { op, ...fields }: Operation): Category[] {
  switch (op) {
    case "delete":
      return categories.filter((category) => category.id !== fields.id);
    case "reorder":
      return (fields.ids as string[]).flatMap((id) => categories.filter((c) => c.id === id));
    case "add":
      return [...categories, { id: `new-${categories.length}`, name: fields.name as string }];
    default:
      return categories.map((c) =>
        c.id === fields.id ? { ...c, name: fields.name as string } : c,
      );
  }
}

// Serves `categories` and `ingredients` in the Collection bundle, in place of the shared items, and
// answers both PATCHes from them, with a 409 at a stale version. `refuse` makes the next Kitchen
// settings PATCH answer that, instead of saving.
async function stubKitchen(page: Page, categories: Category[], ingredients = INGREDIENTS) {
  const stub = {
    categories,
    ingredients,
    version: 7,
    edits: [] as Edit[],
    staples: [] as { id: string; edit: Edit }[],
    refuse: undefined as { status: number; detail: string } | undefined,
  };
  const settings = () => ({
    version: stub.version,
    schema_version: 1,
    store_categories: stub.categories,
  });
  await page.route("**/api/v/collection/*", async (route) => {
    const response = await route.fetch();
    const collection = await response.json();
    await route.fulfill({
      response,
      json: {
        ...collection,
        kitchen_settings: settings(),
        canonical_ingredients: stub.ingredients.map((c) => ({
          family: c.name,
          confirmed: false,
          confirm_batch: null,
          schema_version: 1,
          ...c,
        })),
      },
    });
  });
  await page.route("**/api/kitchen-settings", async (route) => {
    const edit: Edit = route.request().postDataJSON();
    stub.edits.push(edit);
    const refused =
      stub.refuse ??
      (edit.version === stub.version ? undefined : { status: 409, detail: "Version conflict" });
    stub.refuse = undefined;
    if (refused) return route.fulfill({ status: refused.status, json: { detail: refused.detail } });
    stub.categories = edit.operations.reduce(applied, stub.categories);
    stub.version += 1;
    await route.fulfill({ json: settings() });
  });
  await page.route("**/api/canonical-ingredients/*", async (route) => {
    const edit: Edit = route.request().postDataJSON();
    const id = new URL(route.request().url()).pathname.split("/").at(-1) as string;
    stub.staples.push({ id, edit });
    const before = stub.ingredients.find((c) => c.id === id) as Ingredient;
    if (edit.version !== before.version) {
      return route.fulfill({ status: 409, json: { detail: "Version conflict" } });
    }
    const after = {
      ...before,
      pantry_staple: edit.operations[0]?.pantry_staple as boolean,
      version: before.version + 1,
    };
    stub.ingredients = stub.ingredients.map((c) => (c.id === id ? after : c));
    await route.fulfill({ json: after });
  });
  return stub;
}

async function signIn(api: APIRequestContext) {
  const signedIn = await api.post("/api/session", {
    data: { credential: "fake:editor@example.com" },
  });
  expect(signedIn.ok(), "fake sign-in").toBe(true);
}

const button = (page: Page, name: string | RegExp) => page.getByRole("button", { name });
const editButton = (page: Page) => button(page, "Edit");
const saveButton = (page: Page) => button(page, /^Save \d+ changes?$/);
const categories = (page: Page) =>
  page.getByRole("list", { name: "Store Categories" }).getByRole("listitem");
const nameField = (page: Page, category: string) =>
  page.getByRole("textbox", { name: `Name of ${category}`, exact: true });
const draftRow = (page: Page, category: string) =>
  page.locator(".category-rows > li").filter({ has: nameField(page, category) });
const grip = (page: Page, category: string) => draftRow(page, category).locator(".category-grip");
const draftNames = (page: Page) =>
  page
    .getByRole("textbox", { name: /^Name of / })
    .evaluateAll((fields) => fields.map((field) => (field as HTMLInputElement).value));
const ingredients = (page: Page) =>
  page.getByRole("list", { name: "Canonical Ingredients" }).getByRole("listitem");
const ingredientRow = (page: Page, name: string) => ingredients(page).filter({ hasText: name });
const staple = (page: Page, name: string) =>
  page.getByRole("button", { name: `Pantry Staple ${name}` });
const search = (page: Page) =>
  page.getByRole("searchbox", { name: "Search Canonical Ingredients" });
const deleteSheet = (page: Page) => page.getByRole("dialog");

async function editorOpens(page: Page, list: Category[], canonical = INGREDIENTS) {
  const stub = await stubKitchen(page, list, canonical);
  await signIn(page.request);
  await page.goto("/kitchen-settings");
  await expect(editButton(page)).toBeVisible();
  return stub;
}

async function editorEdits(page: Page, list: Category[], canonical = INGREDIENTS) {
  const stub = await editorOpens(page, list, canonical);
  await editButton(page).click();
  await expect(page.getByRole("heading", { name: "Edit Store Categories" })).toBeFocused();
  return stub;
}

// Deletes a saved category through its sheet, moving its Canonical Ingredients to `target`.
async function deleteInto(page: Page, category: string, target: string) {
  await draftRow(page, category).getByRole("button", { name: "Delete" }).click();
  await deleteSheet(page).getByText(target, { exact: true }).click();
  await deleteSheet(page).getByRole("button", { name: "Delete" }).click();
  await expect(deleteSheet(page)).toBeHidden();
}

// Drags a row's grip by `rows` of the list, on the pointer every browser here can drive.
async function dragRows(page: Page, category: string, rows: number) {
  const handle = grip(page, category);
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  const row = await draftRow(page, category).boundingBox();
  if (!box || !row) throw new Error(`no row for ${category}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + rows * (row.height + 12), { steps: 8 });
  await page.mouse.up();
}

// A pointer Playwright's one mouse can't be: a second one, or one the browser gives up on. It has
// no real pointer behind it to capture, so the grip it presses gets a stubbed capture.
const fakeCapture = (handle: Locator) =>
  handle.evaluate((element) => {
    element.setPointerCapture = () => {};
  });
const pointer = (handle: Locator, type: string, pointerId: number, clientY = 0) =>
  handle.dispatchEvent(type, { pointerId, clientY });

// Where a row's grip is, and how far apart its list's rows sit.
async function gripAt(page: Page, category: string) {
  const handle = grip(page, category);
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  const [first, second] = await page
    .locator(".category-rows > li")
    .evaluateAll((rows) => rows.slice(0, 2).map((row) => row.getBoundingClientRect().top));
  if (!box || first === undefined || second === undefined) throw new Error("no rows");
  return { handle, x: box.x + box.width / 2, y: box.y + box.height / 2, stride: second - first };
}

test("a visitor sees the list and which are Pantry Staples, read-only", async ({ page }) => {
  await stubKitchen(page, [AISLES, BAKERY]);
  await page.goto("/kitchen-settings");

  await expect(categories(page)).toHaveText([AISLES.name, BAKERY.name]);
  await expect(ingredients(page).locator(".queued-site")).toHaveText([
    LOAF.name,
    CREAM.name,
    SALT.name,
    RYE.name,
  ]);
  await expect(ingredientRow(page, SALT.name)).toContainText("Pantry Staple");
  await expect(ingredientRow(page, RYE.name)).not.toContainText("Pantry Staple");
  await expect(ingredientRow(page, LOAF.name)).toContainText(BAKERY.name);

  await expect(editButton(page)).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("button")).toHaveCount(0);
  await expect(page.locator("main [aria-pressed]")).toHaveCount(0);
});

test("the search narrows the list, and says when nothing matches", async ({ page }) => {
  await stubKitchen(page, [AISLES, BAKERY]);
  await page.goto("/kitchen-settings");

  await search(page).fill("FLA");
  await expect(ingredients(page)).toHaveCount(1);
  await expect(ingredients(page)).toContainText(SALT.name);

  await search(page).fill("  zzz ");
  await expect(page.getByText("No Canonical Ingredients match “zzz”.")).toBeVisible();
  await expect(ingredients(page)).toHaveCount(0);

  await search(page).fill("");
  await expect(ingredients(page)).toHaveCount(INGREDIENTS.length);
});

test("no Canonical Ingredients says so", async ({ page }) => {
  await stubKitchen(page, [AISLES, BAKERY], []);
  await page.goto("/kitchen-settings");
  await expect(page.getByText("No Canonical Ingredients yet.")).toBeVisible();
  await expect(search(page)).toHaveCount(0);
});

test("an editor's changes all go in one batch, in order, and the list shows them", async ({
  page,
}) => {
  const stub = await editorEdits(page, [AISLES, BAKERY, CHILLED, DELI]);
  await expect(saveButton(page)).toHaveText("Save 0 changes");
  await expect(saveButton(page)).toBeDisabled();

  await nameField(page, BAKERY.name).fill("Breads");
  await expect(saveButton(page)).toHaveText("Save 1 change");

  await deleteInto(page, DELI.name, CHILLED.name);
  await expect(saveButton(page)).toHaveText("Save 2 changes");

  const up = draftRow(page, CHILLED.name).getByRole("button", { name: "Move up" });
  await up.click();
  await expect(up).toBeFocused();
  await expect(saveButton(page)).toHaveText("Save 3 changes");
  await up.click();
  await expect(saveButton(page)).toHaveText("Save 3 changes");
  await expect(up).toBeDisabled();
  await expect(
    draftRow(page, CHILLED.name).getByRole("button", { name: "Move down" }),
  ).toBeFocused();

  await button(page, "Add a category").click();
  await expect(nameField(page, "New category")).toBeFocused();
  await nameField(page, "New category").fill("Sides");
  await expect(saveButton(page)).toHaveText("Save 4 changes");

  // Nothing has gone anywhere until Save.
  expect(stub.edits).toEqual([]);
  await saveButton(page).click();

  await expect(editButton(page)).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  expect(stub.edits).toEqual([
    {
      version: 7,
      operations: [
        { op: "rename", id: BAKERY.id, name: "Breads" },
        { op: "delete", id: DELI.id, move_to: CHILLED.id },
        { op: "reorder", ids: [CHILLED.id, AISLES.id, BAKERY.id] },
        { op: "add", name: "Sides" },
      ],
    },
  ]);
  await expect(categories(page)).toHaveText([CHILLED.name, AISLES.name, "Breads", "Sides"]);
});

test("a drag on the grip reorders the Draft, which Save sends as one reorder", async ({ page }) => {
  const stub = await editorEdits(page, [AISLES, BAKERY, CHILLED, DELI]);
  await expect(grip(page, AISLES.name)).toHaveCSS("touch-action", "none");

  await dragRows(page, AISLES.name, 2);
  await expect.poll(() => draftNames(page)).toEqual(["Bakery", "Chilled", "Aisles", "Deli"]);
  await expect(saveButton(page)).toHaveText("Save 1 change");

  await dragRows(page, DELI.name, -3);
  await expect.poll(() => draftNames(page)).toEqual(["Deli", "Bakery", "Chilled", "Aisles"]);
  await saveButton(page).click();

  await expect(categories(page)).toHaveText(["Deli", "Bakery", "Chilled", "Aisles"]);
  expect(stub.edits[0]?.operations).toEqual([
    { op: "reorder", ids: [DELI.id, BAKERY.id, CHILLED.id, AISLES.id] },
  ]);
});

test("a touch drag on the grip reorders the Draft, and doesn't scroll the page", async ({
  page,
  browserName,
  hasTouch,
}) => {
  test.skip(browserName !== "chromium" || !hasTouch, "needs Chromium's touch input over CDP");
  await editorEdits(page, [AISLES, BAKERY, CHILLED]);
  const handle = grip(page, AISLES.name);
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  const row = await draftRow(page, AISLES.name).boundingBox();
  if (!box || !row) throw new Error("no row");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const scrolled = await page.evaluate(() => window.scrollY);

  const cdp = await page.context().newCDPSession(page);
  const touch = (
    type: "touchStart" | "touchMove" | "touchEnd",
    points: { x: number; y: number }[],
  ) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
  await touch("touchStart", [{ x, y }]);
  for (let step = 1; step <= 8; step++) {
    await touch("touchMove", [{ x, y: y + (step / 8) * (row.height + 12) * 1.2 }]);
  }
  await touch("touchEnd", []);

  await expect.poll(() => draftNames(page)).toEqual(["Bakery", "Aisles", "Chilled"]);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);
});

for (const ending of ["pointercancel", "lostpointercapture"]) {
  test(`a ${ending} mid-drag leaves the order as it was`, async ({ page }) => {
    await editorEdits(page, [AISLES, BAKERY, CHILLED]);
    const { handle, y, stride } = await gripAt(page, AISLES.name);
    await fakeCapture(handle);

    await pointer(handle, "pointerdown", 7, y);
    await pointer(handle, "pointermove", 7, y + 2 * stride);
    await expect(page.locator(".is-dragged")).toHaveCount(1);
    await pointer(handle, ending, 7);
    await expect(page.locator(".is-dragged")).toHaveCount(0);
    await pointer(handle, "pointerup", 7, y + 2 * stride);

    await expect(saveButton(page)).toHaveText("Save 0 changes");
    expect(await draftNames(page)).toEqual(["Aisles", "Bakery", "Chilled"]);
  });
}

test("a right press on the grip doesn't start a drag", async ({ page }) => {
  await editorEdits(page, [AISLES, BAKERY, CHILLED]);
  const { x, y, stride } = await gripAt(page, AISLES.name);

  await page.mouse.move(x, y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(x, y + 2 * stride, { steps: 4 });
  await expect(page.locator(".is-dragged")).toHaveCount(0);
  await page.mouse.up({ button: "right" });

  await expect(saveButton(page)).toHaveText("Save 0 changes");
});

test("a second pointer neither starts a drag nor takes over the one under way", async ({
  page,
}) => {
  await editorEdits(page, [AISLES, BAKERY, CHILLED, DELI]);
  const { handle: held, y, stride } = await gripAt(page, AISLES.name);
  const { handle: other } = await gripAt(page, CHILLED.name);
  await fakeCapture(held);
  await fakeCapture(other);

  await pointer(held, "pointerdown", 7, y);
  await pointer(held, "pointermove", 7, y + stride);

  await pointer(other, "pointerdown", 8, y);
  await pointer(other, "pointermove", 8, y + stride);
  await pointer(other, "pointerup", 8, y + stride);
  for (const type of ["pointermove", "pointerup", "pointercancel", "lostpointercapture"]) {
    await pointer(held, type, 8, y + 3 * stride);
  }
  await expect(draftRow(page, AISLES.name)).toHaveClass("is-dragged");
  await expect(saveButton(page)).toHaveText("Save 0 changes");

  await pointer(held, "pointerup", 7, y + stride);
  await expect.poll(() => draftNames(page)).toEqual(["Bakery", "Aisles", "Chilled", "Deli"]);
});

test("a row held at the window's edge keeps scrolling the page, and stays under the pointer", async ({
  page,
}) => {
  const names = Array.from({ length: 10 }, (_, n) => `Aisle ${n}`);
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("no viewport");
  await page.setViewportSize({ width: viewport.width, height: 480 });
  await editorEdits(
    page,
    names.map((name) => ({ id: name.toLowerCase().replace(" ", "-"), name })),
  );
  // Far enough down that the page has already scrolled when the press lands.
  const from = 3;
  const dragged = names[from] as string;
  const { x, y, stride } = await gripAt(page, dragged);
  const row = draftRow(page, dragged);
  const top = (await row.boundingBox())?.y ?? 0;
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(0);

  await page.mouse.move(x, y);
  await page.mouse.down();
  const edge = 460;
  await page.mouse.move(x, edge, { steps: 4 });
  // No more moves: the pointer is only held.
  await page.waitForFunction((target) => window.scrollY > target, before + 2 * stride);
  const held = (await row.boundingBox())?.y ?? 0;
  expect(Math.abs(held - (top + edge - y))).toBeLessThan(stride / 2);

  // Out of the edge the scroll stops, so the index is exact.
  const middle = 240;
  await page.mouse.move(x, middle);
  const scrolled = await page.evaluate(() => window.scrollY);
  await page.mouse.up();

  const index = from + Math.round((middle + scrolled - (y + before)) / stride);
  expect(index).toBeGreaterThan(from);
  expect(index).toBeLessThan(names.length - 1);
  await expect.poll(async () => (await draftNames(page)).indexOf(dragged)).toBe(index);
});

test("an unsaved category stays at the foot until it's saved", async ({ page }) => {
  await editorEdits(page, [AISLES, BAKERY]);
  await button(page, "Add a category").click();
  await nameField(page, "New category").fill("Sides");

  const added = draftRow(page, "New category");
  await expect(added).toContainText("It can move once it’s saved.");
  await expect(added.locator(".category-grip")).toBeDisabled();
  for (const move of await added.getByRole("button", { name: /^Move/ }).all()) {
    await expect(move).toBeDisabled();
  }
  await expect(
    draftRow(page, BAKERY.name).getByRole("button", { name: "Move down" }),
  ).toBeDisabled();

  // A saved row dragged past it stops above it.
  await dragRows(page, AISLES.name, 3);
  await expect.poll(() => draftNames(page)).toEqual(["Bakery", "Aisles", "Sides"]);
});

test("deleting asks where the Canonical Ingredients move, among saved categories only", async ({
  page,
}) => {
  await editorEdits(page, [AISLES, BAKERY, CHILLED]);
  await button(page, "Add a category").click();
  await nameField(page, "New category").fill("Sides");

  const row = draftRow(page, AISLES.name);
  await row.getByRole("button", { name: "Delete" }).click();
  await expect(deleteSheet(page)).toContainText("Delete Aisles");
  await expect(deleteSheet(page)).toContainText("2 Canonical Ingredients will move.");
  await expect(deleteSheet(page).getByRole("radio")).toHaveCount(2);
  await expect(deleteSheet(page).locator(".choice-text")).toHaveText([BAKERY.name, CHILLED.name]);

  // A target is required.
  const confirm = deleteSheet(page).getByRole("button", { name: "Delete" });
  await expect(confirm).toBeDisabled();

  // Cancel keeps the row, and gives focus back to its Delete.
  await deleteSheet(page).getByRole("button", { name: "Cancel" }).click();
  await expect(deleteSheet(page)).toBeHidden();
  await expect(row.getByRole("button", { name: "Delete" })).toBeFocused();
  await expect.poll(() => draftNames(page)).toEqual(["Aisles", "Bakery", "Chilled", "Sides"]);

  // Bakery takes Aisles' two, so its own sheet counts three, and Aisles is no target now.
  await deleteInto(page, AISLES.name, BAKERY.name);
  await draftRow(page, BAKERY.name).getByRole("button", { name: "Delete" }).click();
  await expect(deleteSheet(page)).toContainText("3 Canonical Ingredients will move.");
  await expect(deleteSheet(page).locator(".choice-text")).toHaveText([CHILLED.name]);
  await deleteSheet(page).getByRole("button", { name: "Cancel" }).click();

  // Deleting a category added in this Draft asks nothing.
  await draftRow(page, "New category").getByRole("button", { name: "Delete" }).click();
  await expect(deleteSheet(page)).toBeHidden();
  await expect.poll(() => draftNames(page)).toEqual(["Bakery", "Chilled"]);
});

test("a chain of deletes goes in the order it was made", async ({ page }) => {
  const stub = await editorEdits(page, [AISLES, BAKERY, CHILLED]);
  await deleteInto(page, AISLES.name, BAKERY.name);
  await deleteInto(page, BAKERY.name, CHILLED.name);
  await saveButton(page).click();

  await expect(categories(page)).toHaveText([CHILLED.name]);
  expect(stub.edits[0]?.operations).toEqual([
    { op: "delete", id: AISLES.id, move_to: BAKERY.id },
    { op: "delete", id: BAKERY.id, move_to: CHILLED.id },
  ]);
});

test("the last saved category can't be deleted, even beside unsaved ones", async ({ page }) => {
  await editorEdits(page, [AISLES, BAKERY]);
  await button(page, "Add a category").click();
  await nameField(page, "New category").fill("Sides");
  await deleteInto(page, AISLES.name, BAKERY.name);

  const last = draftRow(page, BAKERY.name);
  await expect(last.getByRole("button", { name: "Delete" })).toBeDisabled();
  await expect(last).toContainText("The last saved Store Category can’t be deleted.");
  await expect(
    draftRow(page, "New category").getByRole("button", { name: "Delete" }),
  ).toBeEnabled();
});

test("Cancel discards the Draft", async ({ page }) => {
  const stub = await editorEdits(page, [AISLES, BAKERY, CHILLED]);
  await nameField(page, AISLES.name).fill("Other");
  await deleteInto(page, CHILLED.name, BAKERY.name);
  await button(page, "Add a category").click();
  await page.getByRole("main").getByRole("button", { name: "Cancel" }).click();

  await expect(categories(page)).toHaveText([AISLES.name, BAKERY.name, CHILLED.name]);
  await editButton(page).click();
  await expect(saveButton(page)).toHaveText("Save 0 changes");
  expect(stub.edits).toEqual([]);
});

test("blank and duplicate names aren't sent, and keep the Draft", async ({ page }) => {
  const stub = await editorEdits(page, [AISLES, BAKERY]);
  await nameField(page, AISLES.name).fill("  ");
  await saveButton(page).click();
  await expect(page.getByRole("alert")).toHaveText("Each Store Category needs a name.");

  await nameField(page, AISLES.name).fill(" bakery");
  await saveButton(page).click();
  await expect(page.getByRole("alert")).toHaveText("Two Store Categories have the same name.");
  await expect(nameField(page, AISLES.name)).toHaveValue(" bakery");
  expect(stub.edits).toEqual([]);
});

test("a save the API refuses keeps the Draft and shows why", async ({ page }) => {
  const stub = await editorEdits(page, [AISLES, BAKERY]);
  await nameField(page, AISLES.name).fill("Mine");
  stub.refuse = { status: 422, detail: "Two Store Categories have the same name" };
  await saveButton(page).click();

  await expect(page.getByRole("alert")).toHaveText("Two Store Categories have the same name");
  await expect(nameField(page, AISLES.name)).toHaveValue("Mine");
  await expect(saveButton(page)).toHaveText("Save 1 change");
});

test("a save that lost a race discards the Draft and says so", async ({ page }) => {
  const stub = await editorEdits(page, [AISLES, BAKERY]);
  await nameField(page, AISLES.name).fill("Mine");

  // Another device saves first.
  stub.categories = [{ ...AISLES, name: "From elsewhere" }, BAKERY];
  stub.version += 1;
  await saveButton(page).click();

  await expect(page.getByRole("alert")).toHaveText(
    "The Kitchen settings changed on another device. Showing the newer version.",
  );
  await expect(page.getByRole("alert")).toBeFocused();
  await expect(saveButton(page)).toHaveCount(0);
  await expect(categories(page)).toHaveText(["From elsewhere", BAKERY.name]);
});

test("a save that can't reach the API keeps the Draft and says so", async ({ page }) => {
  await editorEdits(page, [AISLES, BAKERY]);
  await nameField(page, AISLES.name).fill("Mine");
  await page.route("**/api/kitchen-settings", (route) => route.abort());
  await saveButton(page).click();

  await expect(page.getByRole("alert")).toHaveText("Couldn’t reach Plateful. Try again.");
  await expect(nameField(page, AISLES.name)).toHaveValue("Mine");
});

test("a Pantry Staple toggle saves at once, pending until the reload", async ({ page }) => {
  const stub = await editorOpens(page, [AISLES, BAKERY]);
  const toggle = staple(page, RYE.name);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(staple(page, SALT.name)).toHaveAttribute("aria-pressed", "true");

  let answer = () => {};
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  await page.route("**/api/canonical-ingredients/*", async (route) => {
    await answered;
    await route.fallback();
  });
  await toggle.click();
  await expect(page.getByRole("button", { name: `Saving… ${RYE.name}` })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.getByRole("button", { name: `Saving… ${RYE.name}` }).dispatchEvent("click");
  answer();

  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(stub.staples).toEqual([
    {
      id: RYE.id,
      edit: { version: 1, operations: [{ op: "set_pantry_staple", pantry_staple: true }] },
    },
  ]);

  // The next write goes at the version the reload brought.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(stub.staples[1]?.edit.version).toBe(2);
});

test("a Pantry Staple toggle that lost a race shows the newer state", async ({ page }) => {
  const stub = await editorOpens(page, [AISLES, BAKERY]);
  // Another device marks it first.
  stub.ingredients = stub.ingredients.map((c) =>
    c.id === RYE.id ? { ...c, pantry_staple: true, version: 2 } : c,
  );
  await staple(page, RYE.name).click();

  await expect(
    page.getByText("The Kitchen settings changed on another device. Showing the newer version."),
  ).toBeVisible();
  await expect(staple(page, RYE.name)).toHaveAttribute("aria-pressed", "true");
});

test("a Pantry Staple toggle leaves an open Draft alone", async ({ page }) => {
  const stub = await editorEdits(page, [AISLES, BAKERY, CHILLED]);
  await nameField(page, AISLES.name).fill("Mine");
  await deleteInto(page, CHILLED.name, BAKERY.name);
  await button(page, "Add a category").click();
  await nameField(page, "New category").fill("Sides");

  await staple(page, RYE.name).click();
  await expect(staple(page, RYE.name)).toHaveAttribute("aria-pressed", "true");

  await expect.poll(() => draftNames(page)).toEqual(["Mine", "Bakery", "Sides"]);
  await expect(saveButton(page)).toHaveText("Save 3 changes");
  await saveButton(page).click();
  await expect(categories(page)).toHaveText(["Mine", BAKERY.name, "Sides"]);
  expect(stub.edits[0]?.version).toBe(7);
});

test("a reload bringing a newer list leaves the Draft, and Save finds the conflict", async ({
  page,
}) => {
  const stub = await editorEdits(page, [AISLES, BAKERY]);
  await nameField(page, AISLES.name).fill("Mine");

  // Another device changes the list, and a toggle's reload brings that in under the Draft.
  stub.categories = [AISLES, BAKERY, CHILLED];
  stub.version += 1;
  await staple(page, RYE.name).click();
  await expect(staple(page, RYE.name)).toHaveAttribute("aria-pressed", "true");

  await expect.poll(() => draftNames(page)).toEqual(["Mine", "Bakery"]);
  await expect(saveButton(page)).toHaveText("Save 1 change");
  await saveButton(page).click();

  await expect(page.getByRole("alert")).toHaveText(
    "The Kitchen settings changed on another device. Showing the newer version.",
  );
  expect(stub.edits[0]?.version).toBe(7);
  await expect(categories(page)).toHaveText([AISLES.name, BAKERY.name, CHILLED.name]);
});

test("editing and toggling are off while offline, with the Draft kept", async ({
  page,
  context,
}) => {
  const stub = await editorOpens(page, [AISLES, BAKERY]);
  await context.setOffline(true);
  await expect(editButton(page)).toBeDisabled();
  await expect(staple(page, RYE.name)).toBeDisabled();
  await expect(staple(page, RYE.name)).toHaveCSS("cursor", "not-allowed");
  const note = "You’re offline. Change the Kitchen settings once you’re back online.";
  await expect(page.getByRole("main")).toContainText(note);
  await context.setOffline(false);
  await expect(editButton(page)).toBeEnabled();

  await editButton(page).click();
  await nameField(page, AISLES.name).fill("Mine");
  await context.setOffline(true);
  await expect(nameField(page, AISLES.name)).toBeDisabled();
  await expect(grip(page, AISLES.name)).toBeDisabled();
  await expect(button(page, "Add a category")).toBeDisabled();
  await expect(saveButton(page)).toBeDisabled();
  await expect(staple(page, RYE.name)).toBeDisabled();
  await context.setOffline(false);

  await expect(nameField(page, AISLES.name)).toHaveValue("Mine");
  expect(stub.edits).toEqual([]);
  expect(stub.staples).toEqual([]);
});

test("editing is off while Plateful is paused", async ({ page }) => {
  await page.route("**/api/sync", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), read_only: true } });
  });
  await stubKitchen(page, [AISLES]);
  await signIn(page.request);
  await page.goto("/kitchen-settings");
  await expect(editButton(page)).toBeDisabled();
  await expect(staple(page, RYE.name)).toBeDisabled();
  await expect(page.getByRole("main")).toContainText("Editing is paused while Plateful updates.");
});

const SEEDED = ["Household", "Produce", "Meat", "Aisles", "Spices", "Dairy", "Frozen", "Bakery"];
const SEEDED_IDS = SEEDED.map((name) => name.toLowerCase());
// The Canonical Ingredients no recipe uses, as `backend/src/recipes/seed.py` has them.
const SEEDED_FREE: Record<string, { category: string; staple: boolean }> = {
  carrot: { category: "produce", staple: false },
  "frozen peas": { category: "frozen", staple: false },
  "olive oil": { category: "aisles", staple: true },
  "sea salt": { category: "spices", staple: true },
};

async function savedCollection(api: APIRequestContext) {
  const { collection_version } = await (await api.get("/api/sync")).json();
  const collection = await (await api.get(`/api/v/collection/${collection_version}`)).json();
  return collection as {
    kitchen_settings: { version: number; store_categories: Category[] };
    canonical_ingredients: Ingredient[];
  };
}

const patchIngredient = (
  api: APIRequestContext,
  { id, version }: Ingredient,
  operations: object[],
) => api.patch(`/api/canonical-ingredients/${id}`, { data: { version, operations } });

// Puts the seeded categories and free ingredients back, whatever a test left. A seeded category is
// never deleted here, since the API would mint a new id for it: tests delete ones they added.
async function restoreSeeded(api: APIRequestContext) {
  const { kitchen_settings: settings } = await savedCollection(api);
  const operations = [
    ...SEEDED_IDS.map((id, index) => ({ op: "rename", id, name: SEEDED[index] })),
    ...settings.store_categories
      .filter(({ id }) => !SEEDED_IDS.includes(id))
      .map(({ id }) => ({ op: "delete", id, move_to: "aisles" })),
    { op: "reorder", ids: SEEDED_IDS },
  ];
  const restored = await api.patch("/api/kitchen-settings", {
    data: { version: settings.version, operations },
  });
  expect(restored.status(), "restore the seeded categories").toBe(200);

  const { canonical_ingredients: all } = await savedCollection(api);
  for (const ingredient of all) {
    const seeded = SEEDED_FREE[ingredient.name];
    if (!seeded) continue;
    const put = await patchIngredient(api, ingredient, [
      { op: "set_store_category", store_category_id: seeded.category },
      { op: "set_pantry_staple", pantry_staple: seeded.staple },
    ]);
    expect(put.status(), `restore ${ingredient.name}`).toBe(200);
  }
}

test.describe("real API", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== REAL_API_PROJECT, "one project writes the shared item");
    await page.goto("/kitchen-settings");
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.project.name !== REAL_API_PROJECT) return;
    await signIn(page.request);
    await restoreSeeded(page.request);
  });

  async function editorOpensReal(page: Page) {
    await signIn(page.request);
    await page.reload();
    await expect(categories(page)).toHaveText(SEEDED);
  }

  test("a visitor gets no way to change anything", async ({ page }) => {
    await expect(categories(page)).toHaveText(SEEDED);
    await expect(ingredientRow(page, "olive oil")).toContainText("Pantry Staple");
    await expect(ingredientRow(page, "butter")).toContainText("Dairy");
    await expect(page.locator("main [aria-pressed]")).toHaveCount(0);
    await expect(editButton(page)).toHaveCount(0);

    const { kitchen_settings: settings } = await savedCollection(page.request);
    const refused = await page.request.patch("/api/kitchen-settings", {
      data: { version: settings.version, operations: [{ op: "add", name: "Nope" }] },
    });
    expect(refused.status()).toBe(403);
  });

  test("add, rename and reorder by drag and by Move save, and come back from the API", async ({
    page,
  }) => {
    await editorOpensReal(page);
    await editButton(page).click();

    await nameField(page, "Meat").fill("Butcher");
    await dragRows(page, "Household", 1);
    await expect
      .poll(() => draftNames(page))
      .toEqual(["Produce", "Household", "Butcher", ...SEEDED.slice(3)]);
    await draftRow(page, "Bakery").getByRole("button", { name: "Move up" }).click();
    await button(page, "Add a category").click();
    await nameField(page, "New category").fill("Example Deli");
    await expect(saveButton(page)).toHaveText("Save 3 changes");
    await saveButton(page).click();

    const expected = [
      "Produce",
      "Household",
      "Butcher",
      "Aisles",
      "Spices",
      "Dairy",
      "Bakery",
      "Frozen",
      "Example Deli",
    ];
    await expect(categories(page)).toHaveText(expected);

    // It's the API's list, not only this page's.
    await page.reload();
    await expect(categories(page)).toHaveText(expected);
  });

  test("deleting a category moves its Canonical Ingredients", async ({ page }) => {
    await editorOpensReal(page);
    await editButton(page).click();
    await button(page, "Add a category").click();
    await nameField(page, "New category").fill("Example Deli");
    await saveButton(page).click();
    await expect(categories(page).last()).toHaveText("Example Deli");

    const { kitchen_settings: settings, canonical_ingredients: all } = await savedCollection(
      page.request,
    );
    const deli = settings.store_categories.find(({ name }) => name === "Example Deli");
    const carrot = all.find(({ name }) => name === "carrot") as Ingredient;
    const moved = await patchIngredient(page.request, carrot, [
      { op: "set_store_category", store_category_id: deli?.id },
    ]);
    expect(moved.status(), "put the carrot in the new category").toBe(200);
    await page.reload();
    await expect(ingredientRow(page, "carrot")).toContainText("Example Deli");

    await editButton(page).click();
    await draftRow(page, "Example Deli").getByRole("button", { name: "Delete" }).click();
    await expect(deleteSheet(page)).toContainText("1 Canonical Ingredient will move.");
    await deleteSheet(page).getByText("Spices", { exact: true }).click();
    await deleteSheet(page).getByRole("button", { name: "Delete" }).click();
    await saveButton(page).click();

    await expect(categories(page)).toHaveText(SEEDED);
    await expect(ingredientRow(page, "carrot")).toContainText("Spices");
    await page.reload();
    await expect(ingredientRow(page, "carrot")).toContainText("Spices");
  });

  test("the API's own refusal shows and keeps the Draft", async ({ page }) => {
    await editorOpensReal(page);
    await editButton(page).click();
    await nameField(page, "Meat").fill("Butcher");

    // Another device takes the name first, so only the save's own answer can tell.
    await page.route("**/api/kitchen-settings", async (route) => {
      const edit = route.request().postDataJSON();
      await route.continue({
        postData: { ...edit, operations: [{ op: "rename", id: "meat", name: "PRODUCE" }] },
      });
    });
    await saveButton(page).click();
    await expect(page.getByRole("alert")).toHaveText("Two Store Categories have the same name");
    await expect(nameField(page, "Meat")).toHaveValue("Butcher");
  });

  test("a staple toggle saves, search finds it, and an open Draft survives", async ({ page }) => {
    await editorOpensReal(page);
    await editButton(page).click();
    await nameField(page, "Meat").fill("Butcher");

    await search(page).fill("carr");
    await expect(ingredients(page)).toHaveCount(1);
    await staple(page, "carrot").click();
    await expect(staple(page, "carrot")).toHaveAttribute("aria-pressed", "true");
    await expect(nameField(page, "Meat")).toHaveValue("Butcher");

    await saveButton(page).click();
    await expect(categories(page).nth(2)).toHaveText("Butcher");
    await page.reload();
    await search(page).fill("carr");
    await expect(staple(page, "carrot")).toHaveAttribute("aria-pressed", "true");
  });
});
