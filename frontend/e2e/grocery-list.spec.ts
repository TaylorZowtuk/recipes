import { expect, type Page, type TestInfo, test } from "@playwright/test";

// The local API's fake sign-in isn't on a deployed stack.
test.skip(!!process.env.E2E_BASE_URL, "needs the local API's fake sign-in");

// In WebKit, page.route stops seeing requests once a service worker registers.
test.use({ serviceWorkers: "block" });

const CHICKEN = { id: "01K7SEED000000000000000001", title: "Lemon Herb Roast Chicken" };
const OATS = { id: "01K7SEED000000000000000003", title: "Overnight Oats" };
const SOUP = { id: "01K7SEED000000000000000004", title: "Tomato Lentil Soup" };
const BEANS = { id: "01K7SEED000000000000000007", title: "Garlic Butter Green Beans" };

// Each test has a slot here, and each project, retry and repeat a block of them, so nothing shares
// a week on the run's one API. A slot is two weeks wide, for › to reach the next. They start well
// after the Week Plan spec's weeks.
const SLOTS = 3;
const FIRST_MONDAY = Date.UTC(2040, 0, 2);
const DAY = 86_400_000;

function ownMonday({ config, project, retry, repeatEachIndex }: TestInfo, slot: number): number {
  const projectIndex = config.projects.findIndex(({ name }) => name === project.name);
  const block = projectIndex + config.projects.length * (retry + 4 * repeatEachIndex);
  return FIRST_MONDAY + (slot + SLOTS * block) * 2 * 7 * DAY;
}

const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);

// Signs in and stops the page's clock at noon on the Wednesday of a week only this test uses.
async function plan(page: Page, testInfo: TestInfo, slot: number) {
  const monday = ownMonday(testInfo, slot);
  const wednesday = new Date(monday + 2 * DAY);
  await page.clock.setFixedTime(
    new Date(wednesday.getUTCFullYear(), wednesday.getUTCMonth(), wednesday.getUTCDate(), 12),
  );
  const signedIn = await page.request.post("/api/session", {
    data: { credential: "fake:editor@example.com" },
  });
  expect(signedIn.ok(), "fake sign-in").toBe(true);
  return isoDay(monday);
}

// Places recipes on the week as another device would, one per day from Monday.
async function placeElsewhere(page: Page, monday: string, recipeIds: string[]) {
  const url = `/api/weeks/${monday}`;
  const { version } = await (await page.request.get(url)).json();
  const placed = await page.request.patch(url, {
    data: {
      version,
      operations: recipeIds.map((recipe_id, day) => ({ op: "place", day, recipe_id })),
    },
  });
  expect(placed.ok(), "place elsewhere").toBe(true);
}

const category = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const tick = (page: Page, name: string) =>
  page.getByRole("button", { name: `Bought ${name}`, exact: true });
const row = (page: Page, name: string) =>
  page.locator(".grocery-item").filter({ has: tick(page, name) });

test("a week's Grocery List: combined, ticked off, kept through a reload, expanded", async ({
  page,
  context,
}, testInfo) => {
  const monday = await plan(page, testInfo, 0);
  await placeElsewhere(page, monday, [CHICKEN.id, SOUP.id, OATS.id, BEANS.id]);
  await page.goto("/week");
  await page.getByRole("link", { name: "Grocery List" }).click();
  await expect(page).toHaveURL(new RegExp(`/week/${monday}/grocery$`));
  await expect(page.getByRole("heading", { level: 1, name: "Grocery List" })).toBeVisible();
  await expect(page.getByText("This week", { exact: true })).toBeVisible();

  // Store Categories in the household's order, Other last.
  await expect(page.locator(".grocery-category h2")).toHaveText([
    "Produce",
    "Meat",
    "Aisles",
    "Spices",
    "Dairy",
    "Other",
  ]);
  // The chicken's 2 onions and the soup's 1, summed; berries only to taste.
  await expect(row(page, "onion")).toContainText("onion 3");
  await expect(row(page, "berries")).toContainText("to taste");
  // An unmatched line as written, with its recipe.
  await expect(row(page, "2 tbsp olive oil")).toContainText(CHICKEN.title);
  await expect(category(page, "Other")).toContainText("2 tbsp olive oil");

  const banner = page.locator(".grocery-not-ready");
  await expect(banner).toContainText("Not on the list until they’re Ready");
  await expect(banner.getByRole("link", { name: BEANS.title })).toHaveAttribute(
    "href",
    new RegExp(BEANS.id),
  );

  // Ticked from the keyboard, the berries sink from the start of Produce to its end, keeping
  // focus and saying so, and stay ticked after a reload.
  const produce = category(page, "Produce").locator(".grocery-item");
  await expect(produce.first()).toContainText("berries");
  await tick(page, "berries").focus();
  await page.keyboard.press("Enter");
  await expect(tick(page, "berries")).toHaveAttribute("aria-pressed", "true");
  await expect(produce.last()).toContainText("berries");
  await expect(tick(page, "berries")).toBeFocused();
  await expect(
    page.getByRole("status").filter({ hasText: "Bought berries, moved to the end of Produce" }),
  ).toBeAttached();
  await page.reload();
  await expect(tick(page, "berries")).toHaveAttribute("aria-pressed", "true");
  await expect(produce.last()).toContainText("berries");

  // Tapping the item, not its tick, shows each recipe's own amount and day.
  const onion = row(page, "onion").getByRole("button", { name: /^onion/ });
  await expect(onion).toHaveAttribute("aria-expanded", "false");
  await onion.click();
  await expect(onion).toHaveAttribute("aria-expanded", "true");
  const breakdown = row(page, "onion").locator(".grocery-breakdown li");
  await expect(breakdown).toHaveCount(2);
  await expect(breakdown.nth(0)).toContainText(CHICKEN.title);
  await expect(breakdown.nth(0)).toContainText(/Mon \d+ 2$/);
  await expect(breakdown.nth(1)).toContainText(SOUP.title);
  await expect(breakdown.nth(1)).toContainText(/Tue \d+ 1$/);

  // Unticked, the berries rise back.
  await tick(page, "berries").click();
  await expect(tick(page, "berries")).toHaveAttribute("aria-pressed", "false");
  await expect(produce.first()).toContainText("berries");
  await expect(
    page.getByRole("status").filter({ hasText: "berries back on the list" }),
  ).toBeAttached();

  // Ticks are never queued, so offline they're off.
  await context.setOffline(true);
  await expect(tick(page, "berries")).toBeDisabled();
  await context.setOffline(false);
});

test("Back from next week's Grocery List returns to next week", async ({ page }, testInfo) => {
  await plan(page, testInfo, 2);
  await page.goto("/week");
  // The household's week, not a visitor's Demo while the session loads.
  await expect(page.getByRole("link", { name: "Grocery List" })).toBeVisible();
  await page.getByRole("button", { name: "Next week" }).click();
  await expect(page.getByText("Next week", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Grocery List" }).click();
  await expect(page.getByText("Nothing planned this week.")).toBeVisible();
  await expect(page.getByText("Next week", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Week Plan" })).toBeVisible();
  await expect(page.getByText("Next week", { exact: true })).toBeVisible();
});

test("an empty week says nothing is planned", async ({ page }, testInfo) => {
  const monday = await plan(page, testInfo, 1);
  await page.goto(`/week/${monday}/grocery`);
  await expect(page.getByText("Nothing planned this week.")).toBeVisible();
});

test("a visitor opening a Grocery List is asked to sign in", async ({ page }) => {
  await page.goto("/week/2040-01-02/grocery");
  await expect(page.getByText("Sign in to see the household’s Grocery List.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
});

test("a visitor's Demo has no Grocery List link", async ({ page }) => {
  await page.goto("/week");
  await expect(page.getByText("Demo — changes aren’t saved")).toBeVisible();
  await expect(page.getByRole("region", { name: /^Mon \d+/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Grocery List" })).toHaveCount(0);
});
