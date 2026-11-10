import { expect, type Page, type TestInfo, test } from "@playwright/test";

// The local API's fake sign-in and fake web (backend/src/recipes/local.py) aren't on a deployed stack.
test.skip(!!process.env.E2E_BASE_URL, "needs the local API's fake sign-in and fake web");

// Each Source is ingested once on the run's one shared API, so each attempt takes a fresh path.
const robotsDenied = (slug: string, { project, retry, repeatEachIndex }: TestInfo) =>
  `https://plateful.test/robots-denied/${slug}-${project.name}-r${retry}-e${repeatEachIndex}`;

// A minimal schema.org page, written for this test, under a title unique to the Source.
const recipePage = (title: string) => `<!doctype html>
<html><head><title>${title}</title>
<script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Recipe",
  name: title,
  author: { "@type": "Person", name: "Paste Test Cook" },
  image: ["https://plateful.test/photos/pasted-a.png", "https://plateful.test/photos/pasted-b.png"],
  recipeYield: "Serves 2",
  recipeIngredient: ["1 cup pasted barley", "2 cups water"],
  recipeInstructions: [
    { "@type": "HowToStep", text: "Simmer the barley in the water." },
    { "@type": "HowToStep", text: "Rest it, then serve." },
  ],
})}</script>
</head><body><h1>${title}</h1></body></html>`;

// About 1 Mi characters of two bytes each in UTF-8: over the 2 MiB limit only when counted as bytes.
const OVERSIZED = "é".repeat(1024 * 1024 + 1);

const titleFor = (url: string) => `Pasted ${url.split("/").pop()}`;

async function openWithNeedsPage(page: Page, url: string) {
  const signedIn = await page.request.post("/api/session", {
    data: { credential: "fake:editor@example.com" },
  });
  expect(signedIn.ok(), "fake sign-in").toBe(true);
  await page.goto("/recipes");
  await expect(page.getByRole("list", { name: "Recipes" })).toBeVisible();
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Add a recipe" }).click();
  await page.getByRole("textbox", { name: "Recipe web address" }).fill(url);
  await page.getByRole("button", { name: "Fetch" }).click();
  await expect(queuedItem(page, url).locator(".badge")).toHaveText("Needs the page pasted in");
}

const queuedItem = (page: Page, url: string) =>
  page.getByRole("list", { name: "Waiting to be added" }).getByRole("listitem").filter({
    hasText: url,
  });
const pasteButton = (page: Page, url: string) =>
  queuedItem(page, url).getByRole("button", { name: /^Paste its page/ });
const pasteField = (page: Page) => page.getByRole("textbox", { name: "The page’s source (HTML)" });
const readPage = (page: Page) => page.getByRole("button", { name: "Read the page" }).click();

// Finishes the Queued Ingest from another device, as far as this page load knows.
async function finishElsewhere(page: Page, url: string) {
  const list = await (await page.request.get("/api/queued-ingests")).json();
  const { id } = list.find((item: { source: { url: string } }) => item.source.url === url);
  const pasted = await page.request.post(`/api/queued-ingests/${id}/pasted-page`, {
    data: { html: recipePage(titleFor(url)) },
  });
  expect(pasted.status(), "pasted page").toBe(200);
  const { source, original } = await pasted.json();
  const saved = await page.request.post(`/api/queued-ingests/${id}/recipe`, {
    data: { source, original, difficulty: null, tags: [] },
  });
  expect(saved.status(), "save").toBe(201);
}

test("an editor pastes a page, reviews what was captured and saves it", async ({
  page,
}, testInfo) => {
  const url = robotsDenied("pasted-barley", testInfo);
  const title = titleFor(url);
  const waiting = `https://plateful.test/blocked/pasted-waiting-${testInfo.project.name}-r${testInfo.retry}-e${testInfo.repeatEachIndex}`;
  await openWithNeedsPage(page, url);

  // One still waiting for the fallback can be pasted too.
  await page.getByRole("textbox", { name: "Recipe web address" }).fill(waiting);
  await page.getByRole("button", { name: "Fetch" }).click();
  await expect(queuedItem(page, waiting).locator(".badge")).toHaveText("Waiting for the fallback");
  await expect(pasteButton(page, waiting)).toBeVisible();

  await pasteButton(page, url).click();
  await expect(page.getByRole("heading", { level: 2, name: "Paste the page" })).toBeFocused();
  await readPage(page);
  await expect(page.getByRole("alert")).toHaveText("Paste the page’s source (HTML) first.");

  // Text that isn't a recipe page says so, and stays to be corrected.
  await pasteField(page).fill("Just the words of a recipe, without its page");
  await readPage(page);
  await expect(page.getByRole("alert")).toContainText("No recipe was found in that.");
  await expect(pasteField(page)).toHaveValue("Just the words of a recipe, without its page");

  // A paste over the limit stays in its box: the screen neither stretches nor sideways-scrolls.
  const box = await pasteField(page).boundingBox();
  await pasteField(page).fill(OVERSIZED);
  await readPage(page);
  await expect(page.getByRole("alert")).toContainText("That’s too large");
  expect(await pasteField(page).inputValue()).toBe(OVERSIZED);
  expect((await pasteField(page).boundingBox())?.height).toBe(box?.height);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  // Nothing pasted is kept anywhere but the page.
  const kept = await page.evaluate(async () => ({
    storage: JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
    databases: await indexedDB.databases(),
  }));
  expect(kept.storage).not.toContain("éé");
  expect(kept.databases).toEqual([]);

  // The real page goes to the same review as a fetched one, and saves as the Queued Ingest.
  await pasteField(page).fill(recipePage(title));
  await readPage(page);
  await expect(page.getByRole("heading", { level: 2, name: title })).toBeFocused();
  await expect(page.getByRole("main")).toContainText("By Paste Test Cook");
  const photos = page.getByRole("group", { name: "Photo" });
  await expect(photos.getByRole("status")).toHaveText("2 photos");
  await expect(
    page.getByRole("tabpanel", { name: "Ingredients" }).getByRole("listitem"),
  ).toHaveText(["1 cup pasted barley", "2 cups water"]);
  const rate = (part: string, n: string) =>
    page.getByRole("group", { name: part }).getByText(n, { exact: true }).click();
  await rate("Prep", "1");
  await rate("Cook", "2");
  await rate("Cleanup", "1");
  await page.getByRole("textbox", { name: "Tags" }).fill("pasted");
  const saved = page.waitForResponse(/\/api\/queued-ingests\/[^/]+\/recipe$/);
  await page.getByRole("button", { name: "Save recipe" }).click();
  expect((await saved).status()).toBe(201);

  // It's a recipe in the grid without a reload, and has left the list.
  await expect(page).toHaveURL(/\/recipes$/);
  await expect(
    page.getByRole("list", { name: "Recipes" }).getByRole("link", { name: new RegExp(title) }),
  ).toContainText("Enrichment pending");
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Add a recipe" }).click();
  await expect(queuedItem(page, waiting)).toBeVisible();
  await expect(queuedItem(page, url)).toHaveCount(0);
});

const GONE = "This recipe isn’t waiting any more";

// Leaves Add a recipe for the grid without a reload, so only a refetch can show the new card.
async function expectInTheGrid(page: Page, title: string) {
  await page.goBack();
  await expect(
    page.getByRole("list", { name: "Recipes" }).getByRole("link", { name: new RegExp(title) }),
  ).toBeVisible();
}

test("a Queued Ingest finished elsewhere says so, on reading and on saving", async ({
  page,
}, testInfo) => {
  const whilePasting = robotsDenied("pasted-gone-pasting", testInfo);
  const whileReviewing = robotsDenied("pasted-gone-reviewing", testInfo);
  await openWithNeedsPage(page, whilePasting);

  // Gone before the page is read: the paste stays, and the list no longer has it.
  await pasteButton(page, whilePasting).click();
  const html = recipePage(titleFor(whilePasting));
  await pasteField(page).fill(html);
  await finishElsewhere(page, whilePasting);
  await readPage(page);
  await expect(page.getByRole("alert")).toContainText(GONE);
  await expect(pasteField(page)).toHaveValue(html);
  await page.getByRole("button", { name: "Back to the list" }).click();
  await expect(queuedItem(page, whilePasting)).toHaveCount(0);
  await expectInTheGrid(page, titleFor(whilePasting));

  // Gone during the review.
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Add a recipe" }).click();
  await page.getByRole("textbox", { name: "Recipe web address" }).fill(whileReviewing);
  await page.getByRole("button", { name: "Fetch" }).click();
  await pasteButton(page, whileReviewing).click();
  await pasteField(page).fill(recipePage(titleFor(whileReviewing)));
  await readPage(page);
  const save = page.getByRole("button", { name: "Save recipe" });
  await expect(save).toBeEnabled();
  await finishElsewhere(page, whileReviewing);
  await save.click();
  await expect(page.getByRole("alert")).toContainText(GONE);
  await page.getByRole("button", { name: "Back to the list" }).click();
  await expect(queuedItem(page, whileReviewing)).toHaveCount(0);
  await expectInTheGrid(page, titleFor(whileReviewing));
});

test("a waiting Queued Ingest is pasted and saved, and the CLI finishing it first says so", async ({
  page,
}, testInfo) => {
  const blocked = (slug: string) =>
    `https://plateful.test/blocked/${slug}-${testInfo.project.name}-r${testInfo.retry}-e${testInfo.repeatEachIndex}`;
  const pasted = blocked("pasted-waiting-saved");
  const finished = blocked("pasted-waiting-finished");
  await openWithNeedsPage(page, robotsDenied("pasted-waiting-first", testInfo));
  for (const url of [pasted, finished]) {
    await page.getByRole("textbox", { name: "Recipe web address" }).fill(url);
    await page.getByRole("button", { name: "Fetch" }).click();
    await expect(queuedItem(page, url).locator(".badge")).toHaveText("Waiting for the fallback");
  }

  await pasteButton(page, pasted).click();
  await pasteField(page).fill(recipePage(titleFor(pasted)));
  await readPage(page);
  await expect(page.getByRole("heading", { level: 2, name: titleFor(pasted) })).toBeFocused();
  await page.getByRole("button", { name: "Back to the list" }).click();

  // The CLI saves it while the editor is pasting.
  await pasteButton(page, finished).click();
  await pasteField(page).fill(recipePage(titleFor(finished)));
  await finishElsewhere(page, finished);
  await readPage(page);
  await expect(page.getByRole("alert")).toContainText(GONE);
  await page.getByRole("button", { name: "Back to the list" }).click();
  await expect(queuedItem(page, finished)).toHaveCount(0);
});

test("pasting is off while offline, and the paste stays", async ({ page, context }, testInfo) => {
  const url = robotsDenied("pasted-offline", testInfo);
  await openWithNeedsPage(page, url);

  await context.setOffline(true);
  await expect(pasteButton(page, url)).toBeDisabled();
  await context.setOffline(false);
  await expect(pasteButton(page, url)).toBeEnabled();

  await pasteButton(page, url).click();
  await pasteField(page).fill("<html>half a page</html>");
  await context.setOffline(true);
  await expect(pasteField(page)).toBeDisabled();
  await expect(page.getByRole("button", { name: "Read the page" })).toBeDisabled();
  await expect(page.getByRole("main")).toContainText(
    "You’re offline. Paste the page once you’re back online.",
  );
  await context.setOffline(false);
  await expect(pasteField(page)).toBeEnabled();
  await expect(pasteField(page)).toHaveValue("<html>half a page</html>");
});
