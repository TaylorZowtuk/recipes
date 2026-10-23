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
