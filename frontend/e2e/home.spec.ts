import { expect, type Page, test } from "@playwright/test";

const bundlePath = /^\/api\/v\/collection\/\d+$/;
const banner = (page: Page) => page.getByRole("status").and(page.locator(".sync-banner"));

test("the home page opens the Collection from its versioned bundle, with no banner for a visitor", {
  tag: "@deployed",
}, async ({ page }) => {
  const bundle = page.waitForResponse(
    (response) => bundlePath.test(new URL(response.url()).pathname) && response.ok(),
  );
  await page.goto("/");

  await expect(page).toHaveURL(/\/recipes$/);
  await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();
  await bundle;
  await expect(page.locator(".sync-banner")).toHaveCount(0);
});

test.describe("without the API", () => {
  test.skip(!!process.env.E2E_BASE_URL, "needs the local API's fake sign-in");
  // In WebKit, page.route stops seeing requests once a service worker registers.
  test.use({ serviceWorkers: "block" });

  test("a visitor with nothing cached sees the Collection isn't available offline, then it once back", async ({
    page,
  }) => {
    let down = true;
    await page.route("**/api/**", (route) =>
      down ? route.abort("internetdisconnected") : route.continue(),
    );
    await page.goto("/recipes");
    await expect(page.getByRole("alert")).toHaveText("Not available offline.");
    await expect(page.locator(".sync-banner")).toHaveCount(0);

    down = false;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("list", { name: "Recipes" })).toBeVisible();
  });

  test("an editor's banner says editing is paused, then offline, and clears once back", async ({
    page,
    context,
  }) => {
    const signedIn = await page.request.post("/api/session", {
      data: { credential: "fake:editor@example.com" },
    });
    expect(signedIn.ok(), "fake sign-in").toBe(true);
    let down = true;
    await page.route("**/api/sync", (route) =>
      down ? route.abort("internetdisconnected") : route.continue(),
    );
    await page.goto("/recipes");
    await expect(banner(page)).toHaveText("Editing is paused.");

    down = false;
    await context.setOffline(true);
    await expect(banner(page)).toHaveText("Offline — ticks will sync later.");
    await context.setOffline(false);
    await expect(banner(page)).toBeEmpty();
  });
});
