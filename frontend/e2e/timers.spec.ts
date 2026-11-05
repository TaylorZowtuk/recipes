import { expect, type Page, test } from "@playwright/test";

// page.clock drives the local build's timers; what's tested here is the app, not a deployed stack.
test.skip(!!process.env.E2E_BASE_URL, "timers are page logic, covered by a local build");

// As in the other signed-in specs, nothing here goes through a service worker.
test.use({ serviceWorkers: "block" });

// One WebKit and one Chromium project cover both engines, both schemes and both layouts.
const PROJECTS = ["iphone-light", "desktop-dark"];

const ID = "01K7SEED000000000000000002";
const NOODLES = "Sesame Noodles with Crispy Tofu";
const NOODLES_PATH = `/recipes/${ID}/sesame-noodles-with-crispy-tofu`;

const dock = (page: Page) => page.getByRole("region", { name: "Timers" });
const startButton = (page: Page) =>
  page.getByRole("button", { name: "Start a timer for 8-10 minutes" });
const row = (page: Page) => dock(page).getByRole("listitem");
const jump = (page: Page) => dock(page).getByRole("link", { name: new RegExp(NOODLES) });

async function startRange(page: Page) {
  await page.clock.install();
  await page.goto(NOODLES_PATH);
  await page.getByRole("tab", { name: "Steps" }).click();
  await startButton(page).click();
  await expect(row(page)).toContainText("Step 3 · 8-10 minutes");
}

test.beforeEach(({ browserName: _ }, testInfo) => {
  test.skip(!PROJECTS.includes(testInfo.project.name), "the two projects cover it");
});

test("a range timer chimes at the low end and alarms at the high end", async ({ page }) => {
  await startRange(page);
  await expect(row(page)).toContainText(/Check in [78]:\d\d/);
  await expect(dock(page)).toBeInViewport({ ratio: 1 });

  await page.clock.fastForward("08:00");
  await expect(row(page)).toContainText(/Done in [12]:\d\d/);
  await expect(row(page)).toHaveClass(/timer-chimed/);
  await expect(dock(page).getByRole("status")).toHaveText(/^Check the 8-10 minutes/);

  await page.clock.fastForward("02:00");
  await expect(row(page)).toContainText("Time’s up");
  await expect(row(page)).toHaveClass(/timer-alarming/);
  await expect(dock(page).getByRole("button", { name: /^Pause/ })).toHaveCount(0);

  await dock(page)
    .getByRole("button", { name: /^\+1 minute on/ })
    .click();
  await expect(row(page)).toContainText(/Done in [01]:\d\d/);
  await dock(page)
    .getByRole("button", { name: /^Cancel/ })
    .click();
  await expect(dock(page)).toBeHidden();
});

test("an editor starts a timer from the row after a Review Item", async ({ page }) => {
  const signedIn = await page.request.post("/api/session", {
    data: { credential: "fake:editor@example.com" },
  });
  expect(signedIn.ok(), "fake sign-in").toBe(true);
  await startRange(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("#step-s3 .review-item .step-timer")).toHaveCount(0);
  await expect(page.locator("#step-s3 > .step-timers .step-timer")).toBeInViewport();
});

test("a second start is refused, leaving the timer running", async ({ page }) => {
  await startRange(page);
  await page.clock.fastForward("01:00");
  await expect(row(page)).toContainText(/Check in [67]:\d\d/);
  await startButton(page).click();
  await expect(dock(page).getByRole("status")).toHaveText(
    "The 8-10 minutes timer is already running.",
  );
  await expect(row(page)).toHaveCount(1);
  await expect(row(page)).toContainText(/Check in [67]:\d\d/);
});

test("two durations in one step run as separate timers, each with its own controls", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/recipes/01K7SEED000000000000000001/lemon-herb-roast-chicken");
  await page.getByRole("tab", { name: "Steps" }).click();
  await page.getByRole("button", { name: "Start a timer for 70-80 minutes" }).click();
  await page.getByRole("button", { name: "Start a timer for 10 minutes" }).click();
  await expect(row(page)).toHaveCount(2);

  await dock(page)
    .getByRole("button", { name: /^Pause 10 minutes/ })
    .click();
  await expect(row(page).nth(1)).toContainText("Paused · Done in");
  await expect(row(page).nth(0)).not.toContainText("Paused");

  await dock(page)
    .getByRole("button", { name: /^Cancel 70-80 minutes/ })
    .click();
  await expect(row(page)).toHaveCount(1);
  await expect(row(page)).toContainText("Step 4 · 10 minutes");
});

test("the dock leaves the foot of the page clear", async ({ page }) => {
  await startRange(page);
  const clearance = await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    const last = document.querySelector(".sync-status")?.getBoundingClientRect().bottom ?? 0;
    return (document.querySelector(".timer-dock-panel")?.getBoundingClientRect().top ?? 0) - last;
  });
  expect(clearance).toBeGreaterThanOrEqual(0);
});

test("a timer jumps to its step from another tab, another screen and on a repeat", async ({
  page,
}) => {
  await startRange(page);
  const step = page.locator("#step-s3");
  const steps = page.getByRole("tab", { name: "Steps" });

  await page.getByRole("tab", { name: "About" }).click();
  await jump(page).click();
  await expect(steps).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(new RegExp(`${NOODLES_PATH}#step-s3$`));
  await expect(step).toBeFocused();
  await expect(step).toBeInViewport();

  // The same address again, once the step has been scrolled and tabbed away from.
  await page.getByRole("tab", { name: "Ingredients" }).click();
  await jump(page).click();
  await expect(steps).toHaveAttribute("aria-selected", "true");
  await expect(step).toBeFocused();
  await expect(step).toBeInViewport();

  await page.getByRole("link", { name: "Week" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Week Plan" })).toBeVisible();
  await jump(page).click();
  await expect(page.getByRole("heading", { level: 1, name: NOODLES })).toBeVisible();
  await expect(step).toBeFocused();
  await expect(step).toBeInViewport();
});

test("a step's address keeps its hash through a stale slug", async ({ page }) => {
  await page.goto(`/recipes/${ID}/an-old-title#step-s3`);
  await expect(page).toHaveURL(new RegExp(`${NOODLES_PATH}#step-s3$`));
  await expect(page.getByRole("tab", { name: "Steps" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#step-s3")).toBeFocused();
});
