import { expect, type Page, test } from "@playwright/test";

// Cooking mode and the Step ticks it sets are page logic on this device; a local build covers them.
test.skip(!!process.env.E2E_BASE_URL, "cooking mode is page logic, covered by a local build");

// As in the timers spec, nothing here goes through a service worker.
test.use({ serviceWorkers: "block" });

// One WebKit and one Chromium project cover both engines, both schemes and both layouts.
const PROJECTS = ["iphone-light", "desktop-dark"];

const NOODLES = "Sesame Noodles with Crispy Tofu";
const NOODLES_PATH = "/recipes/01K7SEED000000000000000002/sesame-noodles-with-crispy-tofu";

const cookButton = (page: Page) => page.getByRole("button", { name: /^(Cook|Resume)$/ });
const cooking = (page: Page) => page.getByRole("dialog", { name: NOODLES });
const progress = (page: Page) => cooking(page).getByRole("progressbar");
const inCooking = (page: Page, name: string) =>
  cooking(page).getByRole("button", { name, exact: true });
const tick = (page: Page, n: number) => page.getByRole("button", { name: `Step ${n} done` });

test.beforeEach(({ browserName: _ }, testInfo) => {
  test.skip(!PROJECTS.includes(testInfo.project.name), "the two projects cover it");
});

test("cooking mode resumes at the first step without a tick, and Finish clears them", async ({
  page,
}) => {
  await page.goto(NOODLES_PATH);
  await expect(cookButton(page)).toHaveText("Cook");

  await cookButton(page).click();
  await expect(cooking(page)).toBeVisible();
  await expect(progress(page)).toHaveAccessibleName("Step 1 of 5");
  await expect(inCooking(page, "Back")).toBeDisabled();
  for (const name of ["Back", "Next"]) {
    const box = await inCooking(page, name).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(70);
  }

  await inCooking(page, "Next").click();
  await expect(progress(page)).toHaveAccessibleName("Step 2 of 5");
  await inCooking(page, "Next").click();
  await expect(progress(page)).toHaveAccessibleName("Step 3 of 5");
  await expect(cooking(page)).toContainText("Fry in 3 tbsp neutral oil over medium-high heat");
  await expect(cooking(page).getByRole("region", { name: "In this step" })).toContainText(
    "neutral oil 3 tbsp",
  );
  await expect(inCooking(page, "Start a timer for 8-10 minutes")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(cooking(page)).toBeHidden();
  await expect(cookButton(page)).toBeFocused();

  // The ticks are kept on this device, so they're still there after a reload.
  await page.reload();
  await expect(cookButton(page)).toHaveText("Resume");
  await page.getByRole("tab", { name: "Steps" }).click();
  await expect(tick(page, 1)).toHaveAttribute("aria-pressed", "true");
  await expect(tick(page, 2)).toHaveAttribute("aria-pressed", "true");
  await expect(tick(page, 3)).toHaveAttribute("aria-pressed", "false");

  await cookButton(page).click();
  await expect(progress(page)).toHaveAccessibleName("Step 3 of 5");
  await inCooking(page, "Next").click();
  await inCooking(page, "Next").click();
  await expect(progress(page)).toHaveAccessibleName("Step 5 of 5");
  await expect(inCooking(page, "Next")).toHaveCount(0);
  await inCooking(page, "Finish").click();
  await expect(cooking(page)).toBeHidden();

  await expect(cookButton(page)).toHaveText("Cook");
  for (const n of [1, 2, 3, 4, 5])
    await expect(tick(page, n)).toHaveAttribute("aria-pressed", "false");
});
