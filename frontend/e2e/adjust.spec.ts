import { expect, type Locator, type Page, test } from "@playwright/test";

// The Adjust choices are page logic on the seeded recipes; a local build covers them.
test.skip(!!process.env.E2E_BASE_URL, "the Adjust sheet is page logic, covered by a local build");

// As in the other specs that plan a Demo week, nothing here goes through a service worker.
test.use({ serviceWorkers: "block" });

const NOODLES = "Sesame Noodles with Crispy Tofu";
const NOODLES_PATH = "/recipes/01K7SEED000000000000000002/sesame-noodles-with-crispy-tofu";
const OATS_PATH = "/recipes/01K7SEED000000000000000003/overnight-oats";
const CHICKEN_PATH = "/recipes/01K7SEED000000000000000001/lemon-herb-roast-chicken";

const adjust = (page: Page) => page.getByRole("button", { name: /^Adjust/ });
const sheet = (page: Page) => page.getByRole("dialog", { name: "Adjust" });
const chip = (page: Page, name: string) => sheet(page).getByRole("button", { name, exact: true });
const line = (page: Page, name: string) =>
  page
    .getByRole("tabpanel", { name: "Ingredients" })
    .getByRole("listitem")
    .filter({ hasText: name });
const amount = (scope: Locator) => scope.locator(".ingredient-amount");
// A step's text, without the number shown beside it.
const step = (page: Page, n: number) =>
  page
    .getByRole("tabpanel", { name: "Steps" })
    .getByRole("listitem")
    .nth(n - 1)
    .locator(".step-body");

async function choose(page: Page, ...names: string[]) {
  await adjust(page).click();
  await expect(sheet(page)).toBeVisible();
  for (const name of names) {
    await chip(page, name).click();
    await expect(chip(page, name)).toHaveAttribute("aria-pressed", "true");
  }
  await sheet(page).getByRole("button", { name: "Done" }).click();
  await expect(sheet(page)).toBeHidden();
}

test("the Adjust sheet scales the ingredients and the steps' amounts, in the units chosen", async ({
  page,
}) => {
  await page.goto(NOODLES_PATH);
  const tofu = line(page, "firm tofu");
  await expect(amount(tofu)).toHaveText("400 g");
  await expect(adjust(page)).toHaveText("Adjust");

  await choose(page, "2×");
  await expect(adjust(page)).toHaveText("Adjust · 2×");
  await expect(amount(tofu)).toHaveText("800 g");
  await page.getByRole("tab", { name: "Steps" }).click();
  await expect(step(page, 2)).toHaveText("Toss 800 g firm tofu in ¼ cup cornstarch.");

  await choose(page, "US");
  await expect(adjust(page)).toHaveText("Adjust · 2× · US");
  await expect(step(page, 2)).toHaveText("Toss 1¾ lb firm tofu in ¼ cup cornstarch.");
  await page.getByRole("tab", { name: "Ingredients" }).click();
  await expect(amount(tofu)).toHaveText("1¾ lb");
});

test("a tap shows an ingredient as a weight, or says why it has none", async ({ page }) => {
  await page.goto(NOODLES_PATH);
  const tahini = line(page, "tahini");
  await expect(amount(tahini)).toHaveText("3 tbsp");
  await page.getByRole("button", { name: "3 tbsp tahini, show in another unit" }).click();
  await expect(amount(tahini)).toHaveText("≈ 45 g");
  await expect(tahini.locator("[aria-live=polite]")).toHaveText("≈ 45 g");
  await page.getByRole("button", { name: "≈ 45 g tahini, show in another unit" }).click();
  await expect(amount(tahini)).toHaveText(/^≈ [\d⅛¼⅜½⅝¾⅞]+ oz$/);

  const soy = line(page, "soy sauce");
  await page.getByRole("button", { name: "2 tbsp soy sauce, why it stays in this unit" }).click();
  await expect(soy.locator("[aria-live=polite]")).toHaveText(
    "2 tbsp. No weight known for this ingredient yet",
  );
  await expect(soy.locator(".ingredient-why")).toBeVisible();
  await expect(amount(soy)).toHaveText("2 tbsp");

  // A new unit system starts every ingredient over in its units.
  await choose(page, "Metric");
  await expect(amount(tahini)).toHaveText("3 tbsp");
});

test("a step's oven temperature follows the unit system", async ({ page }) => {
  await page.goto(CHICKEN_PATH);
  await page.getByRole("tab", { name: "Steps" }).click();
  await expect(step(page, 1)).toContainText("425°F");
  await choose(page, "Metric");
  await expect(step(page, 1)).toContainText("220°C");
  await choose(page, "US");
  await expect(step(page, 1)).toContainText("425°F");
});

test("Metric shows a line in cups in ml and one in ounces in g", async ({ page }) => {
  await page.goto(OATS_PATH);
  const milk = line(page, "milk");
  const yogurt = line(page, "plain yogurt");
  await expect(amount(milk)).toHaveText("½ cup");
  await expect(amount(yogurt)).toHaveText("2 oz");
  await choose(page, "Metric");
  await expect(amount(milk)).toHaveText("118 ml");
  await expect(amount(yogurt)).toHaveText("57 g");
});

test("a recipe opened from a Week Plan day starts at that day's scale", async ({ page }) => {
  await page.clock.setFixedTime(new Date(2030, 0, 9, 12));
  await page.goto("/week");
  // A visitor's Demo week: placing goes at the end of the day, so the new entry is Thursday's last.
  const thursday = page.getByRole("region", { name: /^Thu \d+/ });
  await thursday.getByRole("button", { name: /^\+ Add/ }).click();
  const picker = page.getByRole("dialog", { name: /Pick a recipe/ });
  await picker.getByRole("searchbox").fill("sesame");
  await picker.getByRole("button", { name: NOODLES }).click();
  await expect(picker).toBeHidden();
  await thursday
    .getByRole("button", { name: new RegExp(`^Scale ${NOODLES}`) })
    .last()
    .click();
  await page
    .getByRole("dialog", { name: new RegExp(NOODLES) })
    .getByRole("button", { name: "1½×" })
    .click();

  await thursday.getByRole("link", { name: NOODLES }).last().click();
  await expect(page.getByRole("heading", { level: 1, name: NOODLES })).toBeVisible();
  await expect(adjust(page)).toHaveText("Adjust · 1½×");
  await expect(amount(line(page, "firm tofu"))).toHaveText("600 g");
});

test("a scale that isn't one of the scales opens the recipe at 1×", async ({ page }) => {
  await page.goto(`${NOODLES_PATH}?scale=7`);
  await expect(amount(line(page, "firm tofu"))).toHaveText("400 g");
  await expect(adjust(page)).toHaveText("Adjust");
});

test("a Pending recipe's Adjust is disabled, saying why, and ignores a link's scale", async ({
  page,
}) => {
  await page.goto("/recipes/01K7SEED000000000000000005?scale=2");
  await expect(adjust(page)).toBeDisabled();
  await expect(adjust(page)).toHaveText("Adjust");
  await expect(adjust(page)).toHaveAccessibleDescription(
    "Scaling and units are ready once this recipe is enriched",
  );
});
