import { expect, type Locator, type Page, type TestInfo, test } from "@playwright/test";

// The local API's fake sign-in and fake web (backend/src/recipes/local.py) aren't on a deployed stack.
test.skip(!!process.env.E2E_BASE_URL, "needs the local API's fake sign-in and fake web");

// In WebKit, page.route stops seeing requests once a service worker registers.
test.use({ serviceWorkers: "block" });

const NOODLES = "Sesame Noodles with Crispy Tofu";
const NOODLES_PATH = "/recipes/01K7SEED000000000000000002/sesame-noodles-with-crispy-tofu";
const NOODLES_ID = "01K7SEED000000000000000002";

// Each test has a slot here, and each project, retry and repeat a block of them, so nothing shares
// a week on the run's one API. A slot is four weeks wide, for ‹ and › to reach the weeks around it.
const SLOTS = 17;
const FIRST_MONDAY = Date.UTC(2030, 0, 7);
const DAY = 86_400_000;

function ownMonday({ config, project, retry, repeatEachIndex }: TestInfo, slot: number): number {
  const projectIndex = config.projects.findIndex(({ name }) => name === project.name);
  const block = projectIndex + config.projects.length * (retry + 4 * repeatEachIndex);
  return FIRST_MONDAY + (slot + SLOTS * block) * 4 * 7 * DAY;
}

const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);

// Signs in and stops the page's clock at noon on the Wednesday of a week only this test uses, so
// Monday and Tuesday are past, and today is the same weekday however the suite is run.
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

// Writes to the week as another device would.
async function placeElsewhere(page: Page, monday: string, day: number, recipe_id = NOODLES_ID) {
  const url = `/api/weeks/${monday}`;
  const { version } = await (await page.request.get(url)).json();
  const placed = await page.request.patch(url, {
    data: { version, operations: [{ op: "place", day, recipe_id }] },
  });
  expect(placed.ok(), "place elsewhere").toBe(true);
}

const day = (page: Page, name: string) =>
  page.getByRole("region", { name: new RegExp(`^${name} \\d+`) });
const add = (scope: Locator) => scope.getByRole("button", { name: /^\+ Add/ });
const scale = (scope: Locator, title = NOODLES) =>
  scope.getByRole("button", { name: new RegExp(`^Scale ${title}`) });
const remove = (scope: Locator, title = NOODLES) =>
  scope.getByRole("button", { name: new RegExp(`^Remove ${title}`) });
const daySheet = (page: Page) => page.getByRole("dialog", { name: /^Add to a day/ });
const dayRow = (sheet: Locator, name: string) =>
  sheet.getByRole("button", { name: new RegExp(` ${name} \\d+$`) });
const cardButton = (page: Page, title = NOODLES) =>
  page.getByRole("list", { name: "Recipes" }).getByRole("button", { name: new RegExp(title) });

async function expectTapTarget(target: Locator) {
  const box = await target.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
}

async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

// Answers every PATCH only once `release` is called, so a second tap really lands mid-write.
async function holdWrites(page: Page) {
  const writes: string[] = [];
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/weeks/*", async (route) => {
    if (route.request().method() === "PATCH") {
      writes.push(route.request().postData() ?? "");
      await released;
    }
    await route.continue();
  });
  return { writes, release };
}

// Two presses of the mouse where the first one was, as a person's double-click lands, wherever the
// rows have moved to by the second.
async function doubleClick(page: Page, target: Locator) {
  await target.click({ trial: true });
  const box = await target.boundingBox();
  if (!box) throw new Error("nothing to double-click");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(150);
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
}

async function pick(page: Page, target: Locator, title = NOODLES) {
  await add(target).click();
  const picker = page.getByRole("dialog", { name: /Pick a recipe/ });
  await picker.getByRole("searchbox").fill(title.slice(0, 12).toLowerCase());
  await picker.getByRole("button", { name: title }).click();
  await expect(picker).toBeHidden();
}

test("plan a day: add a recipe, change its scale, keep it through a reload, remove it", async ({
  page,
}, testInfo) => {
  await plan(page, testInfo, 0);
  await page.goto("/week");
  await expect(page.getByRole("heading", { level: 1, name: "Week Plan" })).toBeVisible();
  await expect(page.getByText("This week", { exact: true })).toBeVisible();

  const thursday = day(page, "Thu");
  await expect(thursday).toContainText("Free");
  await expectTapTarget(add(thursday));

  await add(thursday).click();
  const picker = page.getByRole("dialog", { name: /Pick a recipe/ });
  await expect(picker).toContainText("Pick a recipe for Thu");
  const search = picker.getByRole("searchbox", { name: "Search recipe titles" });
  await search.fill("no recipe is called this");
  await expect(picker.getByRole("button", { name: NOODLES })).toBeHidden();
  await search.fill("sesame");
  await picker.getByRole("button", { name: NOODLES }).click();
  await expect(picker).toBeHidden();
  await expect(add(thursday)).toBeFocused();

  // The title links to the recipe, and the scale starts at 1×.
  await expect(thursday.getByRole("link", { name: NOODLES })).toHaveAttribute("href", NOODLES_PATH);
  await expect(thursday).not.toContainText("Free");
  await expect(scale(thursday)).toHaveText("1×");
  await expectTapTarget(scale(thursday));
  await expectTapTarget(remove(thursday));
  await expectNoSidewaysScroll(page);

  await scale(thursday).click();
  const scales = page.getByRole("dialog", { name: new RegExp(NOODLES) });
  await expect(scales.getByRole("button")).toHaveText(["½×", "1×", "1½×", "2×", "3×", "Cancel"]);
  await expect(scales.getByRole("button", { name: "1×", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await scales.getByRole("button", { name: "1½×" }).click();
  await expect(scale(thursday)).toHaveText("1½×");

  await page.reload();
  await expect(scale(thursday)).toHaveText("1½×");
  await expect(thursday.getByRole("link", { name: NOODLES })).toBeVisible();

  await remove(thursday).click();
  await expect(thursday.getByRole("link", { name: NOODLES })).toBeHidden();
  await expect(thursday).toContainText("Free");
  await expect(add(thursday)).toBeFocused();

  await page.reload();
  await expect(thursday).toContainText("Free");
});

test("a day holds several recipes in order", async ({ page }, testInfo) => {
  await plan(page, testInfo, 1);
  await page.goto("/week");
  const friday = day(page, "Fri");
  await pick(page, friday);
  await pick(page, friday, "Tomato Lentil Soup");
  await expect(friday.getByRole("link")).toHaveText([NOODLES, "Tomato Lentil Soup"]);
});

test("‹ and › move between weeks, marking today and the days past", async ({ page }, testInfo) => {
  const monday = await plan(page, testInfo, 2);
  await page.goto("/week");

  const previous = page.getByRole("button", { name: "Previous week" });
  const next = page.getByRole("button", { name: "Next week" });
  const today = page.locator('[aria-current="date"]');
  const past = page.locator(".week-day-past");
  await expectTapTarget(previous);
  await expectTapTarget(next);

  await expect(page.getByText("This week", { exact: true })).toBeVisible();
  await expect(today).toHaveCount(1);
  await expect(today).toContainText("Wed");
  await expect(today).toContainText("Today");
  await expect(past).toHaveCount(2);
  await expect(past.nth(0)).toContainText("Mon");
  await expect(past.nth(1)).toContainText("Tue");

  await next.click();
  await expect(page.getByText("Next week", { exact: true })).toBeVisible();
  await expect(today).toHaveCount(0);
  await expect(past).toHaveCount(0);

  await next.click();
  await expect(page.getByText("Next week", { exact: true })).toBeHidden();
  await expect(page.getByText(/^[A-Z][a-z]{2} \d+ – [A-Z][a-z]{2} \d+$/)).toBeVisible();

  await previous.click();
  await previous.click();
  await previous.click();
  await expect(past).toHaveCount(7);
  await expect(page.getByText("This week", { exact: true })).toBeHidden();

  // A past day stays editable: the household corrects what it cooked.
  await pick(page, day(page, "Tue"));
  await expect(day(page, "Tue").getByRole("link", { name: NOODLES })).toBeVisible();
  await remove(day(page, "Tue")).click();
  await expect(day(page, "Tue")).toContainText("Free");

  // Each week keeps its own plan.
  await placeElsewhere(page, monday, 3);
  await next.click();
  await expect(day(page, "Thu").getByRole("link", { name: NOODLES })).toBeVisible();
  await previous.click();
  await expect(day(page, "Thu")).toContainText("Free");
});

test("+ Week on a card plans days from one sheet and the card shows them", async ({
  page,
}, testInfo) => {
  await plan(page, testInfo, 3);
  await page.goto("/recipes");

  // The card is still a link by its name, with the button beside it.
  const list = page.getByRole("list", { name: "Recipes" });
  await expect(list.getByRole("link", { name: new RegExp(NOODLES) })).toHaveAttribute(
    "href",
    NOODLES_PATH,
  );
  await expect(cardButton(page)).toHaveText("+ Week");
  await expectTapTarget(cardButton(page));
  await expectNoSidewaysScroll(page);

  await cardButton(page).click();
  const sheet = daySheet(page);
  await expect(sheet).toContainText("Add to a day");
  await expect(sheet.getByRole("heading", { name: NOODLES })).toBeVisible();
  await expect(sheet).toContainText("This week");
  await expect(dayRow(sheet, "Mon")).toContainText("Free");
  await expect(dayRow(sheet, "Mon")).toContainText("Log");
  await expect(dayRow(sheet, "Tue")).toContainText("Log");
  await expect(dayRow(sheet, "Wed")).toContainText("Add");
  await expect(dayRow(sheet, "Sun")).toContainText("Add");
  await expectTapTarget(dayRow(sheet, "Wed"));

  // It stays open, so several days can be chosen.
  await dayRow(sheet, "Wed").click();
  await expect(dayRow(sheet, "Wed")).toContainText("✓ Remove");
  await dayRow(sheet, "Fri").click();
  await expect(dayRow(sheet, "Fri")).toContainText("✓ Remove");
  await expect(dayRow(sheet, "Fri")).toContainText(NOODLES);
  await expect(dayRow(sheet, "Fri")).toHaveAccessibleName(
    new RegExp(`^Remove ${NOODLES} from Fri \\d+$`),
  );
  await expect(dayRow(sheet, "Fri")).toHaveAccessibleDescription(NOODLES);
  await expect(dayRow(sheet, "Sun")).toHaveAccessibleName(
    new RegExp(`^Add ${NOODLES} to Sun \\d+$`),
  );
  await expect(dayRow(sheet, "Sun")).toHaveAccessibleDescription("Free");

  // Next week's rows are another week's, and placing there doesn't count as this week.
  await sheet.getByRole("button", { name: "Next week" }).click();
  await expect(sheet).toContainText("Next week");
  await expect(dayRow(sheet, "Mon")).toContainText("Add");
  await dayRow(sheet, "Mon").click();
  await expect(dayRow(sheet, "Mon")).toContainText("✓ Remove");

  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toBeHidden();
  await expect(cardButton(page)).toHaveText("✓ Wed, Fri");
  await expect(cardButton(page)).toBeFocused();

  // ✓ reopens the same sheet at this week; removing there takes the day off the card.
  await cardButton(page).click();
  await expect(sheet).toContainText("This week");
  await dayRow(sheet, "Wed").click();
  await expect(dayRow(sheet, "Wed")).toContainText("Add");
  await page.keyboard.press("Escape");
  await expect(cardButton(page)).toHaveText("✓ Fri");

  await page.reload();
  await expect(cardButton(page)).toHaveText("✓ Fri");
});

test("✓ Remove takes every entry of the recipe off that day, and no other", async ({
  page,
}, testInfo) => {
  const monday = await plan(page, testInfo, 4);
  await placeElsewhere(page, monday, 4);
  await placeElsewhere(page, monday, 4);
  await placeElsewhere(page, monday, 5);
  await page.goto("/recipes");
  await expect(cardButton(page)).toHaveText("✓ Fri, Sat");
  await cardButton(page).click();
  await dayRow(daySheet(page), "Fri").click();
  await expect(dayRow(daySheet(page), "Fri")).toContainText("Free");
  await page.keyboard.press("Escape");
  await expect(cardButton(page)).toHaveText("✓ Sat");
});

test("Add to a day on a recipe opens the same sheet, and the Week Plan links back", async ({
  page,
}, testInfo) => {
  await plan(page, testInfo, 5);
  await page.goto(NOODLES_PATH);
  const button = page.getByRole("button", { name: "Add to a day" });
  await expect(button).toBeVisible();
  await expectTapTarget(button);

  // A Draft hides it, as it hides Edit.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(button).toBeHidden();
  await page.getByRole("button", { name: "Cancel" }).click();

  await button.click();
  const sheet = daySheet(page);
  await expect(sheet.getByRole("heading", { name: NOODLES })).toBeVisible();
  await dayRow(sheet, "Sat").click();
  await expect(dayRow(sheet, "Sat")).toContainText("✓ Remove");
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(button).toBeFocused();

  await page.getByRole("link", { name: "Week", exact: true }).click();
  await day(page, "Sat").getByRole("link", { name: NOODLES }).click();
  await expect(page).toHaveURL(new RegExp(`${NOODLES_PATH}$`));
});

test("a recipe deleted from the Collection keeps its title on the day, without a link", async ({
  page,
}, testInfo) => {
  const monday = await plan(page, testInfo, 6);
  const { project, retry, repeatEachIndex } = testInfo;
  const ingested = await page.request.post("/api/ingest", {
    data: {
      url: `https://plateful.test/week-deleted-${project.name}-r${retry}-e${repeatEachIndex}`,
    },
  });
  const { source, original } = await ingested.json();
  const saved = await page.request.post("/api/recipes", { data: { source, original, tags: [] } });
  const recipe = await saved.json();
  await placeElsewhere(page, monday, 3, recipe.id);
  const deleted = await page.request.delete(`/api/recipes/${recipe.id}`, {
    params: { version: recipe.version },
  });
  expect(deleted.status()).toBe(204);

  await page.goto("/week");
  const thursday = day(page, "Thu");
  await expect(thursday).toContainText(recipe.original.title);
  await expect(thursday.getByRole("link")).toHaveCount(0);
  await expect(remove(thursday, recipe.original.title)).toBeVisible();
});

test("a stale write reloads the week and says it changed, on the Week Plan", async ({
  page,
}, testInfo) => {
  const monday = await plan(page, testInfo, 7);
  await placeElsewhere(page, monday, 3);
  await page.goto("/week");
  await expect(remove(day(page, "Thu"))).toBeVisible();

  // Another device moves the version on, then this one writes from what it read.
  await placeElsewhere(page, monday, 4);
  await remove(day(page, "Thu")).click();
  await expect(page.getByRole("status").filter({ hasText: "changed" })).toHaveText(
    "This Week Plan changed on another device. Showing the newer version.",
  );
  await expect(day(page, "Fri").getByRole("link", { name: NOODLES })).toBeVisible();
  await expect(day(page, "Thu").getByRole("link", { name: NOODLES })).toBeVisible();
});

test("a stale write in the day sheet says so inside the sheet, which stays open", async ({
  page,
}, testInfo) => {
  const monday = await plan(page, testInfo, 8);
  await page.goto("/recipes");
  await cardButton(page).click();
  const sheet = daySheet(page);
  await expect(dayRow(sheet, "Thu")).toContainText("Add");

  await placeElsewhere(page, monday, 4);
  await dayRow(sheet, "Thu").click();
  await expect(sheet.getByRole("status").filter({ hasText: "changed" })).toBeInViewport();
  await expect(dayRow(sheet, "Fri")).toContainText("✓ Remove");
  await expect(dayRow(sheet, "Thu")).toContainText("Add");
});

test("a second tap while a write is in flight sends nothing", async ({ page }, testInfo) => {
  await plan(page, testInfo, 9);
  const writes: string[] = [];
  await page.route("**/api/weeks/*", async (route) => {
    if (route.request().method() === "PATCH") {
      writes.push(route.request().postData() ?? "");
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    await route.continue();
  });
  await page.goto("/recipes");
  await cardButton(page).click();
  const sheet = daySheet(page);
  await expect(dayRow(sheet, "Thu")).toContainText("Add");
  await dayRow(sheet, "Thu").click();
  // Forced, as Playwright would otherwise wait out the row's aria-disabled, unlike a person.
  await dayRow(sheet, "Fri").click({ force: true });
  await expect(dayRow(sheet, "Thu")).toContainText("✓ Remove");
  await expect(dayRow(sheet, "Fri")).toContainText("Add");
  expect(writes).toHaveLength(1);

  // Once it has answered, the next write goes out at the new version.
  await dayRow(sheet, "Fri").click();
  await expect(dayRow(sheet, "Fri")).toContainText("✓ Remove");
  expect(writes.map((body) => JSON.parse(body).version)).toEqual([0, 1]);
});

test("a tap refused mid-write in the day sheet says so, and the notice outlasts the write", async ({
  page,
}, testInfo) => {
  await plan(page, testInfo, 14);
  const { writes, release } = await holdWrites(page);
  await page.goto("/recipes");
  await cardButton(page).click();
  const sheet = daySheet(page);
  await expect(dayRow(sheet, "Thu")).toContainText("Add");
  await dayRow(sheet, "Thu").click();
  await expect.poll(() => writes.length).toBe(1);
  await dayRow(sheet, "Fri").click({ force: true });
  const notice = sheet.getByText("Still saving. Tap again in a moment.");
  await expect(notice).toBeVisible();
  await expect(dayRow(sheet, "Fri")).toHaveCSS("opacity", "0.7");

  release();
  await expect(dayRow(sheet, "Thu")).toContainText("✓ Remove");
  await expect(notice).toBeVisible();
  await expect(dayRow(sheet, "Fri")).toContainText("Add");
  expect(writes).toHaveLength(1);
  await expect(notice).toBeHidden();
});

test("× twice, + Add and a scale chip mid-write change one entry and say so", async ({
  page,
}, testInfo) => {
  const monday = await plan(page, testInfo, 15);
  await placeElsewhere(page, monday, 3);
  await placeElsewhere(page, monday, 3);
  const { writes, release } = await holdWrites(page);
  await page.goto("/week");
  const thursday = day(page, "Thu");
  await expect(remove(thursday)).toHaveCount(2);

  await remove(thursday).first().click();
  await expect.poll(() => writes.length).toBe(1);
  const notice = page.getByText("Still saving. Tap again in a moment.");
  await remove(thursday).first().click({ force: true });
  await expect(notice).toBeVisible();
  await add(thursday).click({ force: true });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await scale(thursday).first().click({ force: true });
  await expect(page.getByRole("dialog")).toHaveCount(0);

  release();
  await expect(remove(thursday)).toHaveCount(1);
  await expect(notice).toBeVisible();
  expect(writes).toHaveLength(1);
});

test("a double-click changes one thing, even when the write answers between the clicks", async ({
  page,
}, testInfo) => {
  const monday = await plan(page, testInfo, 16);
  for (let i = 0; i < 3; i++) await placeElsewhere(page, monday, 3);
  const url = `/api/weeks/${monday}`;
  const onThursday = async () => (await (await page.request.get(url)).json()).days[3].length;
  await page.goto("/week");
  const thursday = day(page, "Thu");
  await expect(remove(thursday)).toHaveCount(3);

  await doubleClick(page, remove(thursday).first());
  await expect(remove(thursday)).toHaveCount(2);
  await page.waitForTimeout(500);
  await expect(remove(thursday)).toHaveCount(2);
  expect(await onThursday()).toBe(2);

  // In the day sheet the row stays put, so the second click would take back what the first placed.
  await page.goto("/recipes");
  await cardButton(page).click();
  const sheet = daySheet(page);
  await expect(dayRow(sheet, "Fri")).toContainText("Add");
  await doubleClick(page, dayRow(sheet, "Fri"));
  await expect(dayRow(sheet, "Fri")).toContainText("✓ Remove");
  await page.waitForTimeout(500);
  await expect(dayRow(sheet, "Fri")).toContainText("✓ Remove");
});

test("coming back to the window shows what changed elsewhere", async ({ page }, testInfo) => {
  const monday = await plan(page, testInfo, 10);
  await page.goto("/week");
  await expect(day(page, "Thu")).toContainText("Free");
  await placeElsewhere(page, monday, 3);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(day(page, "Thu").getByRole("link", { name: NOODLES })).toBeVisible();
});

test("edits are off while offline and while paused", async ({ page, context }, testInfo) => {
  const monday = await plan(page, testInfo, 11);
  await placeElsewhere(page, monday, 3);
  await page.goto("/week");
  const thursday = day(page, "Thu");
  await expect(remove(thursday)).toBeEnabled();

  await context.setOffline(true);
  await expect(
    page.getByText("You’re offline. Plan the week once you’re back online."),
  ).toBeVisible();
  await expect(add(thursday)).toBeDisabled();
  await expect(remove(thursday)).toBeDisabled();
  await expect(scale(thursday)).toBeDisabled();
  await context.setOffline(false);
  await expect(add(thursday)).toBeEnabled();

  await page.route("**/api/sync*", async (route) => {
    const sync = await (await route.fetch()).json();
    await route.fulfill({ json: { ...sync, read_only: "updating" } });
  });
  await page.goto("/recipes");
  await cardButton(page).click();
  const sheet = daySheet(page);
  await expect(sheet).toContainText("Editing is paused while Plateful updates.");
  await expect(dayRow(sheet, "Thu")).toBeDisabled();
});

test("a failed load offers to try again", async ({ page }, testInfo) => {
  await plan(page, testInfo, 12);
  let refuse = true;
  await page.route("**/api/weeks/*", (route) =>
    refuse ? route.fulfill({ status: 500, json: {} }) : route.continue(),
  );
  await page.goto("/week");
  await expect(page.getByRole("alert")).toHaveText("The Week Plan couldn’t be loaded.");
  refuse = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(day(page, "Thu")).toContainText("Free");
});

test("signing out forgets the week", async ({ page }, testInfo) => {
  const monday = await plan(page, testInfo, 13);
  await placeElsewhere(page, monday, 3);
  await page.goto("/recipes");
  await expect(cardButton(page)).toHaveText("✓ Thu");

  const account = page.getByRole("button", { name: "Account" });
  await account.click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(cardButton(page)).toHaveCount(0);

  // Nothing is left to show after signing in again, until the week has loaded afresh: this device
  // shows the Demo, and asks for no week.
  const weeks = weekRequests(page);
  const signedIn = await page.request.post("/api/session", {
    data: { credential: "fake:editor@example.com" },
  });
  expect(signedIn.ok()).toBe(true);
  await page.getByRole("link", { name: "Week", exact: true }).click();
  await expect(page.getByText(DEMO)).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("region")).toHaveCount(7);
  expect(weeks).toEqual([]);
});

// Every request a visitor's Demo must never make: a week read, or any write at all.
function weekRequests(page: Page): string[] {
  const sent: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (!pathname.startsWith("/api/")) return;
    if (pathname.startsWith("/api/weeks") || request.method() !== "GET") {
      sent.push(`${request.method()} ${pathname}`);
    }
  });
  return sent;
}

const DEMO = "Demo — changes aren’t saved";
const plannedDays = (page: Page) => page.getByRole("region").allInnerTexts();

test("a visitor plans a Demo week that a reload resets, and sends nothing", async ({ page }) => {
  const sent = weekRequests(page);
  await page.clock.setFixedTime(new Date(2030, 0, 9, 12));

  await page.goto("/week");
  await expect(page.getByRole("heading", { level: 1, name: "Week Plan" })).toBeVisible();
  await expect(page.getByText(DEMO)).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in");
  await expect(page.getByRole("region")).toHaveCount(7);
  await expect(page.getByRole("button", { name: /^Remove / }).first()).toBeVisible();
  const generated = await plannedDays(page);

  // Placing goes at the end of the day, so the new entry is Thursday's last.
  const thursday = day(page, "Thu");
  const before = await remove(thursday).count();
  await pick(page, thursday);
  await expect(remove(thursday)).toHaveCount(before + 1);
  await expect(scale(thursday).last()).toHaveText("1×");
  await scale(thursday).last().click();
  await page
    .getByRole("dialog", { name: new RegExp(NOODLES) })
    .getByRole("button", { name: "2×" })
    .click();
  await expect(scale(thursday).last()).toHaveText("2×");

  const removes = page.getByRole("button", { name: /^Remove / });
  const entries = await removes.count();
  await removes.first().click();
  await expect(removes).toHaveCount(entries - 1);

  // Each week has its own Demo.
  await page.getByRole("button", { name: "Next week" }).click();
  await expect(page.getByText("Next week", { exact: true })).toBeVisible();
  await expect.poll(() => plannedDays(page)).not.toEqual(generated);

  await page.reload();
  await expect(page.getByText(DEMO)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Remove / }).first()).toBeVisible();
  expect(await plannedDays(page)).toEqual(generated);

  // The rest of the app stays read-only for a visitor.
  await page.goto("/recipes");
  await expect(page.getByRole("link", { name: new RegExp(NOODLES) })).toBeVisible();
  await expect(cardButton(page)).toHaveCount(0);
  await page.goto(NOODLES_PATH);
  await expect(page.getByRole("heading", { level: 1, name: NOODLES })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Ingredients" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add to a day" })).toHaveCount(0);

  expect(sent).toEqual([]);
});
