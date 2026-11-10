import { expect, type Page, test } from "@playwright/test";

// The fake sign-in and the seed's recipes awaiting review exist only on the local API.
test.skip(!!process.env.E2E_BASE_URL, "needs the local API's fake sign-in and seed");

// In WebKit, page.route stops seeing requests once the app registers its service worker.
test.use({ serviceWorkers: "block" });

// Signs in as an editor through a stand-in for Google Identity Services, as sign-in.spec.ts does.
async function signInAsEditor(page: Page) {
  await page.route("https://accounts.google.com/gsi/client", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `window.google = { accounts: { id: {
        initialize(config) { window.__gsi = config; },
        renderButton(parent) {
          const button = document.createElement("button");
          button.textContent = "Sign in with Google";
          button.onclick = () => window.__gsi.callback({ credential: "fake:editor@example.com" });
          parent.replaceChildren(button);
        },
      } } };`,
    }),
  );
  await page.goto("/recipes");
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Sign in with Google" }).click();
  await expect(page).toHaveURL(/\/recipes$/);
}

const chip = (page: Page) => page.getByRole("button", { name: /^Needs Review · \d+$/ });
const grid = (page: Page) => page.getByRole("list", { name: "Recipes" });

test("a visitor sees no Needs Review", async ({ page }) => {
  await page.goto("/recipes");
  await expect(grid(page)).toBeVisible();
  await expect(page.getByRole("button", { name: /Needs Review/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Recipes (needs review)" })).toHaveCount(0);
});

test("an editor narrows the grid to Needs Review and back", async ({ page }) => {
  await signInAsEditor(page);
  await expect(page.getByRole("link", { name: "Recipes (needs review)" }).first()).toBeVisible();
  const all = await grid(page).getByRole("listitem").count();

  await chip(page).click();
  await expect(chip(page)).toHaveAttribute("aria-pressed", "true");
  const first = grid(page).getByRole("listitem").first();
  await expect(first.getByText("Awaiting Review")).toBeVisible();
  await expect(first.getByText(/\d+ to check/)).toBeVisible();
  expect(await grid(page).getByRole("listitem").count()).toBeLessThan(all);

  await chip(page).click();
  await expect(chip(page)).toHaveAttribute("aria-pressed", "false");
  await expect(grid(page).getByRole("listitem")).toHaveCount(all);
  await expect(grid(page).getByText(/\d+ to check/)).toHaveCount(0);
});

test("CANARY: always fails, to check the failing path of sharded CI", async ({ page }) => {
  await page.goto("/");
  expect(1).toBe(2);
});
