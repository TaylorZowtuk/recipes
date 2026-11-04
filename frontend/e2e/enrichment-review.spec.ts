import { expect, type Page, type TestInfo, test } from "@playwright/test";

// The local API's fake sign-in, fake web and service token (backend/src/recipes/local.py) aren't
// on a deployed stack.
test.skip(!!process.env.E2E_BASE_URL, "needs the local API's fake sign-in, fake web and token");

// In Playwright's WebKit, page.route stops seeing requests once the app registers a service worker.
test.use({ serviceWorkers: "block" });

const SERVICE_TOKEN = { "x-plateful-service-token": "local-dev-service-token" };

// Every project shares one local API for the whole run, so each attempt adds its own Source and
// learns its own Canonical Ingredient and wording: once confirmed, a wording can't be learned again.
const attempt = ({ project, retry, repeatEachIndex }: TestInfo) =>
  `${project.name}-r${retry}-e${repeatEachIndex}`;

// A fresh ULID: a first character of 0 to 7, then 25 of Crockford's base 32.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  `0${Array.from({ length: 25 }, () => CROCKFORD[Math.floor(Math.random() * 32)]).join("")}`;

const stamp = (provenance: string, estimated = false) => ({
  provenance,
  confidence: 0.8,
  estimated,
});

const parse = (low: number, unit: string, name: string) => ({
  ...stamp("parser"),
  quantity: { low, high: low },
  unit,
  unit_kind: "volume",
  name,
  preparation: null,
});

// What the enrich CLI might find in the fake web's recipe (2 cups cooked rice, 1 tbsp olive oil,
// 1 tsp kosher salt; Warm the oil in a pan; Add the rice and salt, and stir until hot): a parse of
// each line, the rice matched to a new Canonical Ingredient with a weight, both steps' uses, the
// first step's segments, a suggested Difficulty, and one open Enrichment Issue on the rice's match.
function enrichment(rice: string) {
  const canonicalId = ulid();
  return {
    enrichment_version: 1,
    fdc_release: "sr_legacy-2018-04",
    facts: {
      ingredients: {
        i1: {
          parse: parse(2, "cup", rice),
          match: { ...stamp("llm"), canonical_id: canonicalId, fdc_id: 1001, portion_id: null },
          conversion: {
            ...stamp("fdc", true),
            fdc_id: 1001,
            dataset: "sr_legacy",
            release: "sr_legacy-2018-04",
            density_g_per_ml: 0.66,
            grams_per_count: null,
            count_unit: null,
            refused: null,
            per_100g: { kcal: 130, protein_g: 2.7, fat_g: 0.3, carbs_g: 28, sodium_mg: 1 },
          },
        },
        i2: { parse: parse(1, "tbsp", "olive oil") },
        i3: { parse: parse(1, "tsp", "kosher salt") },
      },
      steps: {
        s1: {
          segments: {
            ...stamp("llm"),
            segments: [
              { t: "text", v: "Warm the " },
              { t: "ingredient", ref: "i2", written: "oil", portion: 1 },
              { t: "text", v: " in a pan." },
            ],
          },
          uses: { ...stamp("llm"), uses: [{ ref: "i2", portion: 1 }] },
        },
        s2: {
          uses: {
            ...stamp("llm"),
            uses: [
              { ref: "i1", portion: 1 },
              { ref: "i3", portion: 1 },
            ],
          },
        },
      },
      difficulty: { ...stamp("llm", true), prep: 2, cook: 3, cleanup: 1 },
    },
    issues: [
      {
        id: ulid(),
        fact_id: "i1.match",
        before: "rice",
        after: rice,
        reason: "The line says cooked rice",
        model: null,
        status: "open",
        confirm_batch: null,
      },
    ],
    canonical_ingredients: [
      {
        id: canonicalId,
        name: rice,
        family: "rice",
        store_category_id: "aisles",
        version: 1,
        schema_version: 1,
      },
    ],
    wordings: [{ wording: rice, canonical_id: canonicalId, schema_version: 1 }],
  };
}

// The fake web titles a page after its last path segment, as Python's str.title() does.
const titleOf = (path: string) =>
  path
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");

const cardOf = (page: Page, title: string) =>
  page.getByRole("list", { name: "Recipes" }).getByRole("link", { name: new RegExp(title) });

// Adds the fake web's recipe at the path, Pending enrichment, and returns its id.
async function addRecipe(page: Page, path: string) {
  const signedIn = await page.request.post("/api/session", {
    data: { credential: "fake:editor@example.com" },
  });
  expect(signedIn.ok(), "fake sign-in").toBe(true);
  await page.goto("/add");
  await page
    .getByRole("textbox", { name: "Recipe web address" })
    .fill(`https://plateful.test/${path}`);
  await page.getByRole("button", { name: "Fetch" }).click();
  await page.getByRole("button", { name: "Save recipe" }).click();
  await expect(page).toHaveURL(/\/recipes$/);
  const card = cardOf(page, titleOf(path));
  await expect(card).toContainText("Enrichment pending");
  const href = await card.getAttribute("href");
  return href?.split("/")[2] ?? "";
}

async function statusOf(page: Page, id: string) {
  const recipe = await page.request.get(`/api/recipes/${id}`);
  expect(recipe.ok(), "get recipe").toBe(true);
  return (await recipe.json()).status;
}

// The toast, apart from the sync status, which is a status region too.
const toast = (page: Page, text: string) => page.getByRole("status").filter({ hasText: text });
const undo = (page: Page) => page.getByRole("status").getByRole("button", { name: "Undo" });
const CHANGED = "This recipe changed on another device. Showing the newer version.";
const READY =
  "Confirmed. This recipe is now Ready, so it joins the Grocery List and fridge matching.";

test("an editor adds a recipe, then reviews it to Ready", async ({ page }, testInfo) => {
  const path = `peach-cobbler-${attempt(testInfo)}`;
  const id = await addRecipe(page, path);
  const rice = `cooked rice ${attempt(testInfo)}`;
  const enriched = await page.request.put(`/api/recipes/${id}/enrichment`, {
    headers: SERVICE_TOKEN,
    data: enrichment(rice),
  });
  expect(enriched.status(), await enriched.text()).toBe(200);
  expect(await statusOf(page, id)).toBe("awaiting_review");

  // It's in Needs Review, with what's flagged and left to check.
  await page.goto("/recipes");
  await page.getByRole("button", { name: /^Needs Review · \d+$/ }).click();
  const card = cardOf(page, titleOf(path));
  await expect(card).toContainText("Awaiting Review");
  await expect(card).toContainText("6 to check, incl. 1 flagged");
  await card.click();

  // Each tab counts what's left to check on it, flagged items included.
  const tab = (label: string, count = 0) =>
    page.getByRole("tab", { name: count ? `${label}, ${count} to check` : label, exact: true });
  await expect(tab("Ingredients", 3)).toBeVisible();
  await expect(tab("Steps", 2)).toBeVisible();
  await expect(tab("About", 1)).toBeVisible();

  // Confirm N on this tab takes the unchecked lines and leaves the flagged one.
  const ingredients = page.getByRole("tabpanel", { name: /^Ingredients/ });
  // The bar counts this tab as the card counts the recipe.
  await expect(ingredients).toContainText("3 to check, incl. 1 flagged");
  await ingredients.getByRole("button", { name: "Confirm 2 on this tab" }).click();
  await expect(toast(page, "Confirmed.")).toBeVisible();
  // The button is gone, so focus moves to the tab rather than dropping to the page.
  await expect(tab("Ingredients", 1)).toBeFocused();
  await expect(ingredients.getByRole("button", { name: /^Confirmed: olive oil/ })).toBeVisible();
  await expect(ingredients.getByRole("button", { name: /^Confirmed: kosher salt/ })).toBeVisible();
  const flagged = ingredients.getByRole("button", { name: /^Flagged: cooked rice/ });
  await expect(flagged).toBeVisible();
  await expect(tab("Ingredients", 1)).toBeVisible();
  await expect(ingredients).toContainText("Tap a flagged item to accept its correction.");

  // The flagged line's sheet shows the correction and that its Canonical Ingredient is new.
  await flagged.click();
  const sheet = page.getByRole("dialog", { name: "2 cups cooked rice" });
  // The note is in view as the sheet opens, not scrolled under its pinned actions.
  await expect(sheet.locator(".review-note")).toBeInViewport({ ratio: 1 });
  await expect(sheet).toContainText("Flagged");
  await expect(sheet).toContainText(`rice → ${rice}`);
  await expect(sheet).toContainText("The line says cooked rice");
  await expect(sheet).toContainText(
    `${rice} is a new Canonical Ingredient. Confirming adds ${rice} for every recipe that uses it.`,
  );
  await sheet.getByRole("button", { name: "Accept correction" }).click();
  await expect(sheet).toBeHidden();
  await expect(toast(page, "Confirmed.")).toBeVisible();
  await expect(ingredients.getByRole("button", { name: /^Confirmed: cooked rice/ })).toBeVisible();
  await expect(tab("Ingredients")).toBeVisible();

  // Undo puts it back as it was: flagged. Undo is gone then, so focus moves to the tab.
  await undo(page).click();
  await expect(toast(page, "Undone.")).toBeVisible();
  await expect(tab("Ingredients", 1)).toBeFocused();
  await expect(flagged).toBeVisible();
  await expect(tab("Ingredients", 1)).toBeVisible();

  // Accepted again, the tab has nothing left to check.
  await flagged.click();
  await sheet.getByRole("button", { name: "Accept correction" }).click();
  await expect(ingredients.getByRole("button", { name: /^Confirmed: cooked rice/ })).toBeVisible();
  await expect(tab("Ingredients")).toBeVisible();

  await tab("Steps", 2).click();
  const steps = page.getByRole("tabpanel", { name: /^Steps/ });
  await steps.getByRole("button", { name: "Confirm 2 on this tab" }).click();
  await expect(steps.getByRole("button", { name: /^Confirmed: / })).toHaveCount(2);
  await expect(tab("Steps")).toBeFocused();
  expect(await statusOf(page, id)).toBe("awaiting_review");

  // Confirming the last item makes the recipe Ready.
  await tab("About", 1).click();
  const about = page.getByRole("tabpanel", { name: /^About/ });
  await about.getByRole("button", { name: "Confirm 1 on this tab" }).click();
  await expect(toast(page, READY)).toBeVisible();
  await expect(tab("About")).toBeVisible();
  expect(await statusOf(page, id)).toBe("ready");

  // Undoing that last confirm sends it back to Awaiting Review.
  await undo(page).click();
  await expect(toast(page, "Undone.")).toBeVisible();
  await expect(tab("About", 1)).toBeVisible();
  expect(await statusOf(page, id)).toBe("awaiting_review");

  await about.getByRole("button", { name: "Confirm 1 on this tab" }).click();
  await expect(toast(page, READY)).toBeVisible();
  expect(await statusOf(page, id)).toBe("ready");
});

test("a review write that lost a race shows the newer recipe, says so, and stays on the tab", async ({
  page,
}, testInfo) => {
  const path = `lemon-rice-${attempt(testInfo)}`;
  const id = await addRecipe(page, path);
  const enriched = await page.request.put(`/api/recipes/${id}/enrichment`, {
    headers: SERVICE_TOKEN,
    data: enrichment(`lemon rice ${attempt(testInfo)}`),
  });
  expect(enriched.status(), await enriched.text()).toBe(200);

  // The same recipe open on two devices, both on Steps.
  const other = await page.context().newPage();
  const steps = (tab: Page) => tab.getByRole("tabpanel", { name: /^Steps/ });
  const stepsTab = (tab: Page) => tab.getByRole("tab", { name: /^Steps/ });
  for (const tab of [page, other]) {
    await tab.goto(`/recipes/${id}`);
    await stepsTab(tab).click();
  }

  // The first device confirms; the second confirms at the version it showed.
  const confirmed = page.waitForResponse((r) => r.url().endsWith("/confirm"));
  await steps(page).getByRole("button", { name: "Confirm 2 on this tab" }).click();
  const batch = (await (await confirmed).json()).confirm_batch;
  await expect(toast(page, "Confirmed.")).toBeVisible();
  await steps(other).getByRole("button", { name: "Confirm 2 on this tab" }).click();
  await expect(toast(other, CHANGED)).toBeVisible();
  await expect(stepsTab(other)).toHaveAttribute("aria-selected", "true");
  await expect(steps(other).getByRole("button", { name: /^Confirmed: / })).toHaveCount(2);

  // Another device undoes that Confirm Batch first, so this device's Undo finds nothing.
  const undone = await page.request.post(`/api/recipes/${id}/confirm-batches/${batch}/undo`);
  expect(undone.status(), await undone.text()).toBe(200);
  await undo(page).click();
  await expect(toast(page, CHANGED)).toBeVisible();
  await expect(stepsTab(page)).toHaveAttribute("aria-selected", "true");
  await expect(steps(page).getByRole("button", { name: /^Confirmed: / })).toHaveCount(0);

  // A sheet whose opener is gone when it closes returns focus to the selected tab.
  const opener = steps(page)
    .getByRole("button", { name: /^Unchecked: / })
    .first();
  await opener.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await opener.evaluate((button) => button.remove());
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(stepsTab(page)).toBeFocused();
});

test("the toast waits while Undo has focus or the mouse, keeps focus on a failed Undo, and Undo is off while offline", async ({
  page,
  context,
}, testInfo) => {
  const path = `pear-crumble-${attempt(testInfo)}`;
  const id = await addRecipe(page, path);
  const enriched = await page.request.put(`/api/recipes/${id}/enrichment`, {
    headers: SERVICE_TOKEN,
    data: enrichment(`pearl rice ${attempt(testInfo)}`),
  });
  expect(enriched.status(), await enriched.text()).toBe(200);
  await page.clock.install();
  await page.goto(`/recipes/${id}`);
  await page.getByRole("tab", { name: /^Steps/ }).click();
  const steps = page.getByRole("tabpanel", { name: /^Steps/ });
  await steps.getByRole("button", { name: "Confirm 2 on this tab" }).click();
  await expect(toast(page, "Confirmed.")).toBeVisible();

  // Undo has focus, so the toast stays past its 10 seconds; it goes once focus leaves.
  await undo(page).focus();
  await page.clock.runFor(15_000);
  await expect(toast(page, "Confirmed.")).toBeVisible();
  await page.getByRole("tab", { name: /^Steps/ }).focus();
  await page.mouse.move(0, 0);
  // The timer restarts once the page has seen focus leave, so run the clock until it has.
  await expect(async () => {
    await page.clock.runFor(11_000);
    await expect(toast(page, "Confirmed.")).toBeHidden({ timeout: 500 });
  }).toPass();

  // Offline, a new toast's Undo is off and says why.
  await page.getByRole("tab", { name: /^About/ }).click();
  const about = page.getByRole("tabpanel", { name: /^About/ });
  await about.getByRole("button", { name: "Confirm 1 on this tab" }).click();
  await expect(toast(page, "Confirmed.")).toBeVisible();

  // With the mouse over it, the toast stays too.
  if (testInfo.project.name.startsWith("desktop")) {
    await undo(page).hover();
    await page.clock.runFor(15_000);
    await expect(toast(page, "Confirmed.")).toBeVisible();
    await page.mouse.move(0, 0);
  }

  // An Undo that fails keeps its button, and focus stays on it.
  await page.route("**/confirm-batches/*/undo", (route) => route.abort());
  await undo(page).focus();
  await page.keyboard.press("Enter");
  await expect(toast(page, "Couldn’t reach Plateful. Try again.")).toBeVisible();
  await expect(undo(page)).toBeFocused();
  await page.unroute("**/confirm-batches/*/undo");

  await context.setOffline(true);
  await expect(undo(page)).toBeDisabled();
  await expect(toast(page, "Couldn’t reach Plateful.")).toContainText(
    "You’re offline. Undo once you’re back online.",
  );
  await context.setOffline(false);
  await expect(undo(page)).toBeEnabled();
});
