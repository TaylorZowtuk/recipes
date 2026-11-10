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

// The seed's two durations in one step, in a list too short to show both rows.
async function startInShortList(page: Page) {
  await page.clock.install();
  await page.goto("/recipes/01K7SEED000000000000000001/lemon-herb-roast-chicken");
  await page.getByRole("tab", { name: "Steps" }).click();
  await page.addStyleTag({ content: ".timer-list { max-height: 100px; }" });
  await page.getByRole("button", { name: "Start a timer for 70-80 minutes" }).click();
  await expect(row(page)).toHaveCount(1);
}

const list = (page: Page) => dock(page).getByRole("list");
const scrollListTo = (page: Page, top: number) =>
  list(page).evaluate((element, to) => element.scrollTo(0, to), top);
const pageScroll = (page: Page) => page.evaluate(() => window.scrollY);

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
  await expect(page.getByRole("heading", { level: 1, name: NOODLES })).toBeFocused();
});

test("a chime sounds two notes and an alarm three beeps, through real audio nodes", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const Real = OscillatorNode;
    const counted = window as unknown as { oscillators: number };
    counted.oscillators = 0;
    window.OscillatorNode = class extends Real {
      constructor(...args: ConstructorParameters<typeof Real>) {
        super(...args);
        counted.oscillators += 1;
      }
    };
  });
  const oscillators = () =>
    page.evaluate(() => (window as unknown as { oscillators: number }).oscillators);

  await startRange(page);
  expect(await oscillators()).toBe(0);
  await page.clock.fastForward("08:00");
  await expect(row(page)).toHaveClass(/timer-chimed/);
  await expect.poll(oscillators).toBe(2);
  await page.clock.fastForward("02:00");
  await expect(row(page)).toHaveClass(/timer-alarming/);
  // The alarm repeats on the running clock, so this first one may not be the last.
  await expect.poll(oscillators).toBeGreaterThanOrEqual(5);
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

  await dock(page)
    .getByRole("button", { name: /^Resume 10 minutes/ })
    .click();
  await expect(row(page)).not.toContainText("Paused");
  await page.clock.fastForward("01:00");
  await expect(row(page)).toContainText(/Done in (8:\d\d|9:00)/);
});

test("focus moves from Pause to +1 minute when the alarm takes Pause away", async ({ page }) => {
  await page.clock.install();
  await page.goto("/recipes/01K7SEED000000000000000007/garlic-butter-green-beans");
  await page.getByRole("tab", { name: "Steps" }).click();
  await page.getByRole("button", { name: "Start a timer for 1 minute" }).click();
  await dock(page)
    .getByRole("button", { name: /^Pause/ })
    .focus();

  await page.clock.fastForward("01:00");
  await expect(row(page)).toHaveClass(/timer-alarming/);
  await expect(dock(page).getByRole("button", { name: /^\+1 minute on/ })).toBeFocused();
});

test("the alarm leaves focus alone when Pause didn't have it", async ({ page }) => {
  await page.clock.install();
  await page.goto("/recipes/01K7SEED000000000000000007/garlic-butter-green-beans");
  await page.getByRole("tab", { name: "Steps" }).click();
  await page.getByRole("button", { name: "Start a timer for 1 minute" }).click();
  const pause = dock(page).getByRole("button", { name: /^Pause/ });
  const cancel = dock(page).getByRole("button", { name: /^Cancel/ });
  await pause.focus();
  await cancel.focus();

  await page.clock.fastForward("01:00");
  await expect(row(page)).toHaveClass(/timer-alarming/);
  await expect(cancel).toBeFocused();

  // A Pause that went with focus leaves nothing behind for the next alarm.
  const addMinute = dock(page).getByRole("button", { name: /^\+1 minute on/ });
  await addMinute.click();
  await pause.focus();
  await page.clock.fastForward("01:00");
  await expect(addMinute).toBeFocused();
  await addMinute.click();
  await cancel.focus();
  await page.clock.fastForward("01:00");
  await expect(row(page)).toHaveClass(/timer-alarming/);
  await expect(cancel).toBeFocused();
});

test("a new timer scrolls into view inside the list, not the page", async ({ page }) => {
  await startInShortList(page);
  const before = await pageScroll(page);
  await page.getByRole("button", { name: "Start a timer for 10 minutes" }).dispatchEvent("click");
  await expect(row(page)).toHaveCount(2);
  await expect(row(page).nth(1)).toBeInViewport({ ratio: 1 });
  expect(await pageScroll(page)).toBe(before);
});

test("an alarming row scrolls into view inside the list, in its place", async ({ page }) => {
  await startInShortList(page);
  await page.getByRole("button", { name: "Start a timer for 10 minutes" }).dispatchEvent("click");
  await expect(row(page)).toHaveCount(2);
  const before = await pageScroll(page);

  await scrollListTo(page, 0);
  await page.clock.fastForward("10:00");
  await expect(row(page).nth(1)).toHaveClass(/timer-alarming/);
  await expect(row(page).nth(1)).toContainText("10 minutes");
  await expect(row(page).nth(1)).toBeInViewport({ ratio: 1 });

  // The first row's alarm scrolls the other way. A chime is no reason to scroll.
  await scrollListTo(page, 1000);
  await page.clock.fastForward("01:00:00");
  await expect(row(page).nth(0)).toHaveClass(/timer-chimed/);
  await expect(row(page).nth(1)).toBeInViewport({ ratio: 1 });
  await page.clock.fastForward("10:00");
  await expect(row(page).nth(0)).toHaveClass(/timer-alarming/);
  await expect(row(page).nth(0)).toBeInViewport({ ratio: 1 });
  expect(await pageScroll(page)).toBe(before);
});

test("the status region stays in the accessibility tree while empty, taking no room", async ({
  page,
}) => {
  await startRange(page);
  const status = dock(page).getByRole("status");
  await expect(status).toHaveCount(1);
  await expect(status).toBeEmpty();
  expect(await status.evaluate((element) => element.getBoundingClientRect().height)).toBe(0);
});

test("the dock leaves the foot of the page clear", async ({ page }) => {
  await startRange(page);
  // --dock-height follows the dock a frame later, from its ResizeObserver, so this waits for it.
  const clearance = () =>
    page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      const last = document.querySelector(".sync-status")?.getBoundingClientRect().bottom ?? 0;
      return (document.querySelector(".timer-dock-panel")?.getBoundingClientRect().top ?? 0) - last;
    });
  await expect.poll(clearance).toBeGreaterThanOrEqual(0);
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

test("a step's address opened cold ends with focus on the step", async ({ page }) => {
  await page.goto(`${NOODLES_PATH}#step-s3`);
  await expect(page.locator("#step-s3")).toBeFocused();
});

// Setting the hash goes through the router as a navigation, which a timer can do after its step
// has gone. An opened-from-the-list recipe, so the first address isn't the one being returned to.
test("a jump to a step that's gone focuses the title", async ({ page }) => {
  await page.goto("/recipes");
  await page.getByRole("link", { name: NOODLES }).click();
  const steps = page.getByRole("tab", { name: "Steps" });
  await steps.click();
  await expect(steps).toBeFocused();

  await page.evaluate(() => {
    window.location.hash = "#step-gone";
  });
  await expect(page.getByRole("heading", { level: 1, name: NOODLES })).toBeFocused();
});

test("Forward to a jump shows the step again, whichever tab is open", async ({ page }) => {
  await startRange(page);
  await page.getByRole("tab", { name: "About" }).click();
  await jump(page).click();
  await expect(page.locator("#step-s3")).toBeFocused();

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${NOODLES_PATH}$`));
  await expect(page.getByRole("tab", { name: "Steps" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Ingredients" }).click();
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`${NOODLES_PATH}#step-s3$`));
  await expect(page.getByRole("tab", { name: "Steps" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#step-s3")).toBeFocused();
  await expect(page.locator("#step-s3")).toBeInViewport();
});

test("leaving Edit with a step in the address keeps focus and the view on the step", async ({
  page,
}) => {
  const signedIn = await page.request.post("/api/session", {
    data: { credential: "fake:editor@example.com" },
  });
  expect(signedIn.ok(), "fake sign-in").toBe(true);
  await startRange(page);
  await jump(page).click();
  const step = page.locator("#step-s3");
  await expect(step).toBeFocused();

  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("heading", { name: /^Edit/ })).toBeFocused();
  // Only a tap during Edit says to finish: this step was jumped to before it opened. One reading,
  // as a retrying assertion would wait out a wrong notice and pass.
  await page.waitForTimeout(250);
  expect(await dock(page).getByRole("status").textContent()).toBe("");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(step).toBeFocused();
  await expect(step).toBeInViewport();
});

test("a timer tapped during Edit says to finish editing, and keeps the Draft", async ({ page }) => {
  const signedIn = await page.request.post("/api/session", {
    data: { credential: "fake:editor@example.com" },
  });
  expect(signedIn.ok(), "fake sign-in").toBe(true);
  await startRange(page);
  await page.getByRole("button", { name: "Edit" }).click();
  const tags = page.getByRole("textbox", { name: "Tags" });
  await tags.fill("soup");

  await jump(page).click();
  await expect(dock(page).getByRole("status")).toHaveText("Finish editing to see this step.");
  await expect(tags).toHaveValue("soup");

  // A repeat tap says so again, once the notice has gone.
  await expect(dock(page).getByRole("status")).toBeEmpty();
  await jump(page).click();
  await expect(dock(page).getByRole("status")).toHaveText("Finish editing to see this step.");
});

test("leaving Edit with a step in the address still shows why Edit closed", async ({ page }) => {
  const signedIn = await page.request.post("/api/session", {
    data: { credential: "fake:editor@example.com" },
  });
  expect(signedIn.ok(), "fake sign-in").toBe(true);
  await startRange(page);
  await jump(page).click();
  await expect(page.locator("#step-s3")).toBeFocused();

  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("textbox", { name: "Tags" }).fill("soup");
  // Another device saved first. Stubbed, as this server's seed recipes are shared between tests.
  await page.route("**/api/recipes/*", (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 409, json: {} })
      : route.continue(),
  );
  await page.getByRole("button", { name: "Save 1 change" }).click();

  const notice = page.getByRole("alert");
  await expect(notice).toContainText("changed on another device");
  await expect(notice).toBeFocused();
  await expect(notice).toBeInViewport();
});
