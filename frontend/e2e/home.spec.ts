import { expect, test } from "@playwright/test";

test("the home page shows Plateful and the API's sync status", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Plateful" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Up to date · collection v0");
});
