import { type APIRequestContext, expect, type Page, test } from "@playwright/test";

// The local API's fake sign-in isn't on a deployed stack.
test.skip(!!process.env.E2E_BASE_URL, "needs the local API's fake sign-in");

// In WebKit, page.route stops seeing requests once a service worker registers.
test.use({ serviceWorkers: "block" });

// A test can end with a stubbed bundle in flight, whose response goes as the page closes.
test.afterEach(({ page }) => page.unrouteAll({ behavior: "ignoreErrors" }));

// All the Favorite Sites are one item on the run's one API, so a project's save would be another's
// 409. So each test here gets a list of its own through `stubSites`, which covers the page in every
// browser. What only the real API shows is tested by the "real API" tests, in one project only,
// which leave the seeded sites as they found them.
const REAL_API_PROJECT = "desktop-light";

type Site = { id: string; name: string; address: string; note: string; recipe_count: number };
type Operation = { op: string; id: string; [field: string]: unknown };
type Edit = { version: number; operations: Operation[] };

const siteId = (n: number) => `01K7E2E${"0".repeat(18)}${n}`;
const KITCHEN: Site = {
  id: siteId(1),
  name: "Synthetic Kitchen",
  address: "https://kitchen.example.com/",
  note: "Weeknight dinners.",
  recipe_count: 3,
};
const BAKES: Site = {
  id: siteId(2),
  name: "Synthetic Bakes",
  address: "https://bakes.example.com/bread",
  note: "",
  recipe_count: 1,
};
const SOUPS: Site = {
  id: siteId(3),
  name: "Synthetic Soups",
  address: "https://soups.example.com/",
  note: "",
  recipe_count: 2,
};
const SALADS: Site = {
  id: siteId(4),
  name: "Synthetic Salads",
  address: "https://salads.example.com/",
  note: "",
  recipe_count: 0,
};

// What `PATCH /api/favorite-sites` does to the stub's list. A changed address counts no recipes.
function applied(sites: Site[], { op, id, ...fields }: Operation): Site[] {
  switch (op) {
    case "delete":
      return sites.filter((site) => site.id !== id);
    case "reorder":
      return (fields.ids as string[]).flatMap((id) => sites.filter((site) => site.id === id));
    case "add":
      return [...sites, { note: "", ...fields, id: siteId(9), recipe_count: 0 } as Site];
    case "set_address":
      return sites.map((s) => (s.id === id ? { ...s, ...fields, recipe_count: 0 } : s));
    default:
      return sites.map((s) => (s.id === id ? { ...s, ...fields } : s));
  }
}

// Serves `sites` in the Collection bundle, in place of the shared item, and answers the PATCH
// from them. `refuse` makes the next PATCH answer that, instead of saving.
async function stubSites(page: Page, sites: Site[]) {
  const stub = {
    sites,
    version: 7,
    edits: [] as Edit[],
    refuse: undefined as { status: number; detail: string; sites?: Site[] } | undefined,
  };
  const listed = () => ({ version: stub.version, sites: stub.sites });
  await page.route("**/api/v/collection/*", async (route) => {
    const response = await route.fetch();
    const collection = await response.json();
    await route.fulfill({ response, json: { ...collection, favorite_sites: listed() } });
  });
  await page.route("**/api/favorite-sites", async (route) => {
    const edit: Edit = route.request().postDataJSON();
    stub.edits.push(edit);
    if (stub.refuse) {
      const { status, detail, sites } = stub.refuse;
      stub.sites = sites ?? stub.sites;
      stub.refuse = undefined;
      return route.fulfill({ status, json: { detail } });
    }
    stub.sites = edit.operations.reduce(applied, stub.sites);
    stub.version += 1;
    await route.fulfill({ json: listed() });
  });
  return stub;
}

async function signIn(api: APIRequestContext) {
  const signedIn = await api.post("/api/session", {
    data: { credential: "fake:editor@example.com" },
  });
  expect(signedIn.ok(), "fake sign-in").toBe(true);
}

const list = (page: Page) => page.getByRole("list", { name: "Favorite Sites" });
const listed = (page: Page) => list(page).getByRole("listitem");
const siteNames = (page: Page) => list(page).locator(".queued-site");
const inDraft = (page: Page, name: string) => page.getByRole("group", { name, exact: true });
const field = (page: Page, site: string, label: string) =>
  inDraft(page, site).getByRole("textbox", { name: label });
const button = (page: Page, name: string | RegExp) => page.getByRole("button", { name });
const saveButton = (page: Page) => button(page, /^Save \d+ changes?$/);
const addFromSite = (page: Page) => button(page, /Add a recipe from this site/);
const heading = (page: Page) => page.getByRole("heading", { level: 1, name: "Favorite Sites" });

async function editorOpens(page: Page, sites: Site[]) {
  const stub = await stubSites(page, sites);
  await signIn(page.request);
  await page.goto("/sites");
  await expect(heading(page)).toBeVisible();
  await expect(button(page, "Edit")).toBeVisible();
  return stub;
}

async function editorEdits(page: Page, sites: Site[]) {
  const stub = await editorOpens(page, sites);
  await button(page, "Edit").click();
  await expect(page.getByRole("heading", { name: "Edit Favorite Sites" })).toBeFocused();
  return stub;
}

test("a visitor sees the list with its links and counts, read-only", async ({ page }) => {
  await stubSites(page, [KITCHEN, BAKES]);
  await page.goto("/sites");

  await expect(siteNames(page)).toHaveText([KITCHEN.name, BAKES.name]);
  const kitchen = listed(page).first();
  const link = kitchen.getByRole("link", { name: KITCHEN.address });
  await expect(link).toHaveAttribute("href", KITCHEN.address);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(kitchen).toContainText(KITCHEN.note);
  await expect(kitchen).toContainText("3 recipes");
  await expect(listed(page).last()).toContainText("1 recipe");

  await expect(button(page, "Edit")).toHaveCount(0);
  await expect(addFromSite(page)).toHaveCount(0);
});

test("an empty list says so", async ({ page }) => {
  await stubSites(page, []);
  await page.goto("/sites");
  await expect(page.getByText("No Favorite Sites yet.")).toBeVisible();
  await expect(list(page)).toHaveCount(0);
});

test("an editor's changes all go in one batch, in order, and the list shows them", async ({
  page,
}) => {
  const stub = await editorEdits(page, [KITCHEN, BAKES, SOUPS, SALADS]);
  await expect(saveButton(page)).toHaveText("Save 0 changes");
  await expect(saveButton(page)).toBeDisabled();

  await field(page, KITCHEN.name, "Note").fill("Quick ones.");
  await expect(saveButton(page)).toHaveText("Save 1 change");
  await field(page, BAKES.name, "Name").fill("Synthetic Breads");
  await expect(saveButton(page)).toHaveText("Save 2 changes");
  await expect(inDraft(page, SOUPS.name)).toContainText("2 recipes");
  await field(page, SOUPS.name, "Address").fill("https://broths.example.com/");
  await expect(inDraft(page, SOUPS.name)).not.toContainText("recipes");
  await expect(saveButton(page)).toHaveText("Save 3 changes");

  await inDraft(page, SALADS.name).getByRole("button", { name: "Delete" }).click();
  await expect(inDraft(page, SALADS.name)).toHaveCount(0);
  await expect(saveButton(page)).toHaveText("Save 4 changes");

  const up = inDraft(page, SOUPS.name).getByRole("button", { name: "Move up" });
  await up.click();
  await expect(up).toBeFocused();
  await expect(saveButton(page)).toHaveText("Save 5 changes");
  await up.click();
  await expect(saveButton(page)).toHaveText("Save 5 changes");
  // At the top Move up is off, so focus rests on the row's other move button.
  await expect(up).toBeDisabled();
  await expect(inDraft(page, SOUPS.name).getByRole("button", { name: "Move down" })).toBeFocused();
  await inDraft(page, SOUPS.name).getByRole("button", { name: "Move down" }).click();

  await button(page, "Add a site").click();
  await expect(field(page, "New site", "Name")).toBeFocused();
  await field(page, "New site", "Name").fill("Synthetic Sides");
  await field(page, "New site", "Address").fill("https://sides.example.com/");
  await expect(saveButton(page)).toHaveText("Save 6 changes");
  // It can't move until it's saved, and the sites above it can't move below it.
  await expect(inDraft(page, "New site")).not.toContainText("recipe");
  await expect(inDraft(page, "New site").getByRole("button", { name: /^Move/ })).toHaveCount(2);
  for (const move of await inDraft(page, "New site").getByRole("button", { name: /^Move/ }).all()) {
    await expect(move).toBeDisabled();
  }
  await expect(inDraft(page, BAKES.name).getByRole("button", { name: "Move down" })).toBeDisabled();

  // Nothing has gone anywhere until Save.
  expect(stub.edits).toEqual([]);
  await saveButton(page).click();

  await expect(button(page, "Edit")).toBeVisible();
  await expect(heading(page)).toBeFocused();
  expect(stub.edits).toEqual([
    {
      version: 7,
      operations: [
        { op: "set_note", id: KITCHEN.id, note: "Quick ones." },
        { op: "set_address", id: SOUPS.id, address: "https://broths.example.com/" },
        { op: "rename", id: BAKES.id, name: "Synthetic Breads" },
        { op: "delete", id: SALADS.id },
        { op: "reorder", ids: [KITCHEN.id, SOUPS.id, BAKES.id] },
        { op: "add", name: "Synthetic Sides", address: "https://sides.example.com/", note: "" },
      ],
    },
  ]);
  await expect(siteNames(page)).toHaveText([
    KITCHEN.name,
    SOUPS.name,
    "Synthetic Breads",
    "Synthetic Sides",
  ]);
  await expect(listed(page).first()).toContainText("Quick ones.");
  await expect(listed(page).nth(1)).toContainText("0 recipes");
  await expect(listed(page).nth(2)).toContainText("1 recipe");
});

test("reverting a change takes it out of the count", async ({ page }) => {
  await editorEdits(page, [KITCHEN, BAKES]);
  await field(page, KITCHEN.name, "Name").fill("Other");
  await expect(saveButton(page)).toHaveText("Save 1 change");
  await field(page, KITCHEN.name, "Name").fill(KITCHEN.name);
  await expect(saveButton(page)).toHaveText("Save 0 changes");
});

test("Cancel discards the Draft", async ({ page }) => {
  const stub = await editorEdits(page, [KITCHEN, BAKES]);
  await field(page, KITCHEN.name, "Name").fill("Other");
  await inDraft(page, BAKES.name).getByRole("button", { name: "Delete" }).click();
  await button(page, "Add a site").click();
  await button(page, "Cancel").click();

  await expect(siteNames(page)).toHaveText([KITCHEN.name, BAKES.name]);
  await button(page, "Edit").click();
  await expect(field(page, KITCHEN.name, "Name")).toHaveValue(KITCHEN.name);
  await expect(saveButton(page)).toHaveText("Save 0 changes");
  expect(stub.edits).toEqual([]);
});

test("leaving the page discards the Draft", async ({ page }) => {
  await editorEdits(page, [KITCHEN, BAKES]);
  await field(page, KITCHEN.name, "Name").fill("Other");
  await page.getByRole("link", { name: "Week" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Week Plan" })).toBeVisible();
  await page.getByRole("link", { name: "Sites" }).click();
  await expect(siteNames(page)).toHaveText([KITCHEN.name, BAKES.name]);
  await expect(button(page, "Edit")).toBeVisible();
});

test("a save that lost a race shows the newer list and says so", async ({ page }) => {
  const stub = await editorEdits(page, [KITCHEN, BAKES]);
  await field(page, KITCHEN.name, "Name").fill("Mine");

  // Another device saves first.
  stub.refuse = {
    status: 409,
    detail: "Version conflict: reload and try again",
    sites: [{ ...KITCHEN, name: "From elsewhere" }, BAKES],
  };
  await saveButton(page).click();

  await expect(page.getByRole("alert")).toHaveText(
    "The Favorite Sites changed on another device. Showing the newer version.",
  );
  await expect(page.getByRole("alert")).toBeFocused();
  await expect(saveButton(page)).toHaveCount(0);
  await expect(siteNames(page)).toHaveText(["From elsewhere", BAKES.name]);
});

test("a save the API refuses keeps the Draft and shows why", async ({ page }) => {
  const stub = await editorEdits(page, [KITCHEN, BAKES]);
  await field(page, KITCHEN.name, "Name").fill("Mine");
  stub.refuse = { status: 422, detail: "Two sites are on the same host" };
  await saveButton(page).click();

  await expect(page.getByRole("alert")).toHaveText("Two sites are on the same host");
  await expect(field(page, KITCHEN.name, "Name")).toHaveValue("Mine");
  await expect(saveButton(page)).toHaveText("Save 1 change");
});

test("a site with no name or address isn't sent", async ({ page }) => {
  const stub = await editorEdits(page, [KITCHEN]);
  await button(page, "Add a site").click();
  await saveButton(page).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Each site needs a name and an address that starts with https://.",
  );
  expect(stub.edits).toEqual([]);
});

test("editing is off while offline, in the list and in a Draft", async ({ page, context }) => {
  const stub = await editorOpens(page, [KITCHEN, BAKES]);
  await context.setOffline(true);
  await expect(button(page, "Edit")).toBeDisabled();
  await expect(addFromSite(page).first()).toBeDisabled();
  const note = "You’re offline. Edit the Favorite Sites once you’re back online.";
  await expect(page.getByRole("main")).toContainText(note);
  await context.setOffline(false);
  await expect(button(page, "Edit")).toBeEnabled();

  await button(page, "Edit").click();
  await field(page, KITCHEN.name, "Name").fill("Mine");
  await context.setOffline(true);
  await expect(field(page, KITCHEN.name, "Name")).toBeDisabled();
  await expect(button(page, "Add a site")).toBeDisabled();
  await expect(saveButton(page)).toBeDisabled();
  await expect(page.getByRole("main")).toContainText(note);
  await context.setOffline(false);

  // The Draft is still there, and nothing was queued.
  await expect(field(page, KITCHEN.name, "Name")).toHaveValue("Mine");
  expect(stub.edits).toEqual([]);
});

test("editing is off while Plateful is paused", async ({ page }) => {
  await page.route("**/api/sync", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), read_only: true } });
  });
  await stubSites(page, [KITCHEN]);
  await signIn(page.request);
  await page.goto("/sites");
  await expect(button(page, "Edit")).toBeDisabled();
  await expect(addFromSite(page)).toBeDisabled();
  await expect(page.getByRole("main")).toContainText("Editing is paused while Plateful updates.");
});

test("Add a recipe from this site opens the site and goes to an empty Add a recipe", async ({
  page,
  context,
}) => {
  await context.route(KITCHEN.address, (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>Synthetic Kitchen</title>" }),
  );
  await editorOpens(page, [KITCHEN, BAKES]);

  const opened = context.waitForEvent("page");
  await addFromSite(page).first().click();
  const tab = await opened;
  await tab.waitForURL(KITCHEN.address);
  expect(await tab.evaluate(() => window.opener)).toBeNull();
  await tab.close();

  await expect(page).toHaveURL(/\/add$/);
  await expect(page.getByRole("main")).toContainText(`from ${KITCHEN.name}`);
  await expect(page.getByRole("textbox", { name: "Recipe web address" })).toHaveValue("");

  // Opened any other way, it shows no hint. Going to /add from /add would be a reload, which keeps
  // the navigation's state.
  await page.goto("/recipes");
  await page.goto("/add");
  await expect(page.getByRole("textbox", { name: "Recipe web address" })).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText(`from ${KITCHEN.name}`);
});

test("a Draft has no Add a recipe from this site", async ({ page }) => {
  await editorEdits(page, [KITCHEN]);
  await expect(addFromSite(page)).toHaveCount(0);
});

const SEEDED_KITCHEN = {
  id: "01K7SEED0000000000000000F1",
  name: "Example Kitchen",
  address: "https://www.example.com/",
  note: "Weeknight dinners that hold up.",
};
const SEEDED_BAKES = {
  id: "01K7SEED0000000000000000F2",
  name: "Example Bakes",
  address: "https://example.org/bread",
  note: "",
};

async function savedSites(api: APIRequestContext) {
  const { collection_version } = await (await api.get("/api/sync")).json();
  const collection = await (await api.get(`/api/v/collection/${collection_version}`)).json();
  return collection.favorite_sites as { version: number; sites: Site[] };
}

// Puts the seeded sites back as `backend/src/recipes/seed.py` has them, whatever a test left.
async function restoreSeeded(api: APIRequestContext) {
  const { version, sites } = await savedSites(api);
  const seeded = [SEEDED_KITCHEN, SEEDED_BAKES];
  const operations = [
    ...seeded.flatMap(({ id, name, address, note }) => [
      { op: "rename", id, name },
      { op: "set_address", id, address },
      { op: "set_note", id, note },
    ]),
    ...sites
      .filter((site) => !seeded.some(({ id }) => id === site.id))
      .map(({ id }) => ({ op: "delete", id })),
    { op: "reorder", ids: seeded.map(({ id }) => id) },
  ];
  const restored = await api.patch("/api/favorite-sites", { data: { version, operations } });
  expect(restored.status(), "restore the seeded sites").toBe(200);
}

test.describe("real API", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== REAL_API_PROJECT, "one project writes the shared item");
    await signIn(page.request);
    await page.goto("/sites");
    await expect(listed(page).first()).toBeVisible();
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.project.name === REAL_API_PROJECT) await restoreSeeded(page.request);
  });

  test("a batch saves, and the counts and order come back from the API", async ({ page }) => {
    const { sites } = await savedSites(page.request);
    const kitchenRecipes = sites.find((site) => site.id === SEEDED_KITCHEN.id)?.recipe_count;
    expect(kitchenRecipes, "the seeded recipes on example.com").toBeGreaterThan(1);
    await button(page, "Edit").click();

    // The API checks hosts on the final list, so a clash is refused and the Draft survives.
    await field(page, SEEDED_BAKES.name, "Address").fill("https://example.com/");
    await saveButton(page).click();
    await expect(page.getByRole("alert")).toHaveText("Two sites are on the same host");

    // Swapping the two addresses in one batch is fine, and swaps their counts.
    await field(page, SEEDED_KITCHEN.name, "Address").fill("https://example.org/");
    await field(page, SEEDED_KITCHEN.name, "Name").fill("Example Bakes Too");
    await inDraft(page, SEEDED_BAKES.name).getByRole("button", { name: "Move up" }).click();
    await button(page, "Add a site").click();
    await field(page, "New site", "Name").fill("Example Elsewhere");
    await field(page, "New site", "Address").fill("https://example.net/");
    await field(page, "New site", "Note").fill("A new one.");
    await expect(saveButton(page)).toHaveText("Save 5 changes");
    await saveButton(page).click();

    await expect(siteNames(page)).toHaveText([
      SEEDED_BAKES.name,
      "Example Bakes Too",
      "Example Elsewhere",
    ]);
    await expect(listed(page).first()).toContainText(`${kitchenRecipes} recipes`);
    await expect(listed(page).nth(1)).toContainText("0 recipes");
    await expect(listed(page).nth(2)).toContainText("A new one.");

    await button(page, "Edit").click();
    await inDraft(page, "Example Elsewhere").getByRole("button", { name: "Delete" }).click();
    await saveButton(page).click();
    await expect(siteNames(page)).toHaveText([SEEDED_BAKES.name, "Example Bakes Too"]);

    // It's the API's list, not only this page's.
    await page.reload();
    await expect(siteNames(page)).toHaveText([SEEDED_BAKES.name, "Example Bakes Too"]);
  });

  test("a save that lost a real race shows the newer list", async ({ page }) => {
    await button(page, "Edit").click();
    await field(page, SEEDED_KITCHEN.name, "Note").fill("Mine.");

    // Another device saves first.
    const { version } = await savedSites(page.request);
    const elsewhere = await page.request.patch("/api/favorite-sites", {
      data: {
        version,
        operations: [{ op: "set_note", id: SEEDED_KITCHEN.id, note: "From elsewhere." }],
      },
    });
    expect(elsewhere.status(), "patch elsewhere").toBe(200);

    await saveButton(page).click();
    await expect(page.getByRole("alert")).toHaveText(
      "The Favorite Sites changed on another device. Showing the newer version.",
    );
    await expect(listed(page).first()).toContainText("From elsewhere.");
    await expect(saveButton(page)).toHaveCount(0);
  });
});
