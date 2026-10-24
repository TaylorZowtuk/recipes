import { expect, test } from "@playwright/test";

test("the home page opens the Collection and shows the API's sync status", {
  tag: "@deployed",
}, async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveURL(/\/recipes$/);
  await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();
  // The Collection has a status line of its own.
  const syncStatus = page.getByRole("status").and(page.locator(".sync-status"));
  await expect(syncStatus).toHaveText(/^Up to date · collection v\d+$/);
});

test.describe("after the sync poll fails", () => {
  // In WebKit, page.route stops seeing requests once a service worker registers.
  test.use({ serviceWorkers: "block" });

  test("the sync status catches up when the network comes back", async ({ page, context }) => {
    let failed = false;
    await page.route("**/api/sync", (route) => {
      if (failed) return route.continue();
      failed = true;
      return route.abort("internetdisconnected");
    });
    await page.goto("/recipes");
    const syncStatus = page.getByRole("status").and(page.locator(".sync-status"));
    await expect(syncStatus).toHaveText("Editing is paused.");

    await context.setOffline(true);
    await context.setOffline(false);

    await expect(syncStatus).toHaveText(/^Up to date · collection v\d+$/);
  });
});
