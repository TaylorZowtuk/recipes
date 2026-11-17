import { expect, type Page, test } from "@playwright/test";

// The synthetic seed the e2e server loads (backend/src/recipes/seed.py), and the fake sign-in only
// the local API accepts.
test.skip(!!process.env.E2E_BASE_URL, "needs the local seed and fake sign-in");

const OATS = { id: "01K7SEED000000000000000003", title: "Overnight Oats" };
const SOUP = { id: "01K7SEED000000000000000004", title: "Tomato Lentil Soup" };
const pathOf = (recipe: typeof OATS) =>
  `/recipes/${recipe.id}/${recipe.title.toLowerCase().replaceAll(" ", "-")}`;

const grid = (page: Page) => page.getByRole("list", { name: "Recipes" });
const banner = (page: Page) => page.getByRole("status").and(page.locator(".sync-banner"));
const ingredients = (page: Page) => page.getByRole("tabpanel", { name: "Ingredients" });

async function signInAsEditor(page: Page) {
  const signedIn = await page.request.post("/api/session", {
    data: { credential: "fake:editor@example.com" },
  });
  expect(signedIn.ok(), "fake sign-in").toBe(true);
}

// Waits until the sync engine has cached the recipe, and the image at `card` when given.
async function cached(page: Page, recipe: typeof OATS, card?: string) {
  const has = () =>
    page.evaluate(
      async ({ id, card }) => {
        const paths = async (name: string) =>
          (await (await caches.open(name)).keys()).map((request) => new URL(request.url).pathname);
        const recipes = await paths("plateful-data");
        return (
          recipes.some((path) => path.startsWith(`/api/v/recipes/${id}/`)) &&
          (!card || (await paths("plateful-cards")).includes(card))
        );
      },
      { id: recipe.id, card },
    );
  await expect.poll(has).toBe(true);
}

async function openFromGrid(page: Page, recipe: typeof OATS) {
  await page
    .getByRole("navigation", { name: "Places" })
    .getByRole("link", { name: /^Recipes/ })
    .click();
  await grid(page)
    .getByRole("link", { name: new RegExp(recipe.title) })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: recipe.title })).toBeVisible();
}

test.describe("with service workers blocked", () => {
  // Reads come from the sync engine's own cache, with no service worker to answer them.
  test.use({ serviceWorkers: "block" });

  test("an editor reads a recipe never opened before offline, with editing off", async ({
    page,
    context,
  }) => {
    await signInAsEditor(page);
    await page.goto("/recipes");
    await expect(grid(page)).toBeVisible();
    await cached(page, OATS);

    await context.setOffline(true);
    await expect(banner(page)).toHaveText("Offline — ticks will sync later.");
    await openFromGrid(page, OATS);
    await expect(ingredients(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeDisabled();
  });

  test("a visitor reads an opened recipe offline, but not one never opened", async ({
    page,
    context,
  }) => {
    await page.goto(pathOf(SOUP));
    await expect(ingredients(page)).toBeVisible();
    await cached(page, SOUP);

    await context.setOffline(true);
    await openFromGrid(page, OATS);
    await expect(page.getByRole("alert")).toHaveText("Not available offline.");
    await openFromGrid(page, SOUP);
    await expect(ingredients(page)).toBeVisible();
    await expect(page.locator(".sync-banner")).toHaveCount(0);
  });
});

test("reopened offline, the app shows a cached recipe and its card-size photo", async ({
  page,
  context,
  browserName,
}) => {
  // Playwright's WebKit has no service workers, and without one the page can't reopen offline.
  test.skip(browserName !== "chromium", "Playwright's WebKit has no service workers");
  await signInAsEditor(page);
  await page.goto("/recipes");
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const card = await grid(page)
    .getByRole("link", { name: new RegExp(OATS.title) })
    .locator("img")
    .getAttribute("src");
  await cached(page, OATS, card ?? "no card image");

  // The full-size photo was never opened, so the hero falls back to the card-size copy, which
  // the service worker serves from the sync engine's cache. The browser's own HTTP cache, which
  // keeps the immutable images too, is emptied so it can't answer instead.
  await (await context.newCDPSession(page)).send("Network.clearBrowserCache");
  await context.setOffline(true);
  const heroResponse = page.waitForResponse((response) => new URL(response.url()).pathname === card);
  await page.goto(pathOf(OATS));
  await expect(ingredients(page)).toBeVisible();
  const hero = page.locator(".plate-hero img");
  await expect(hero).toHaveAttribute("src", /-card\.webp$/);
  await expect
    .poll(() => hero.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBeGreaterThan(0);
  expect((await heroResponse).fromServiceWorker()).toBe(true);
});
