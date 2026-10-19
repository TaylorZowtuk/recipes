import { expect, test } from "@playwright/test";

test("the home page opens the Collection and shows the API's sync status", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveURL(/\/recipes$/);
  await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Up to date · collection v8");
});
