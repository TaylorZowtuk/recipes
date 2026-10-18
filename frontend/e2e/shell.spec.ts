import { expect, type Locator, type Page, test } from "@playwright/test";

const tabs = [
  { name: "Recipes", path: "/recipes", title: "Collection" },
  { name: "Week", path: "/week", title: "Week Plan" },
  { name: "Fridge", path: "/fridge", title: "Fridge" },
  { name: "Sites", path: "/sites", title: "Favorite Sites" },
];

const backgrounds = { light: "rgb(247, 248, 245)", dark: "rgb(18, 23, 21)" };

const isDesktop = (projectName: string) => projectName.startsWith("desktop");
const places = (page: Page) => page.getByRole("navigation", { name: "Places" });
const accountButton = (page: Page) => page.getByRole("link", { name: "Sign in" });

async function expectTapTarget(target: Locator) {
  const box = await target.boundingBox();
  expect(box, "tap target is laid out").not.toBeNull();
  expect(box?.width).toBeGreaterThanOrEqual(50);
  expect(box?.height).toBeGreaterThanOrEqual(50);
}

async function expectNavPlacement(page: Page, projectName: string) {
  const viewport = page.viewportSize();
  const box = await places(page).boundingBox();
  if (!viewport || !box) throw new Error("no viewport or navigation box");
  if (isDesktop(projectName)) {
    // A left rail: flush with the left edge and as tall as the window.
    expect(box.x).toBe(0);
    expect(box.height).toBeCloseTo(viewport.height, 0);
    expect(box.width).toBeLessThan(viewport.width / 4);
  } else {
    // A bottom tab bar: flush with the bottom edge and as wide as the window.
    expect(box.y + box.height).toBeCloseTo(viewport.height, 0);
    expect(box.width).toBeCloseTo(viewport.width, 0);
    expect(box.height).toBeLessThan(viewport.height / 4);
  }
}

test("each tab opens from the navigation, which stays in place", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/recipes$/);

  for (const tab of tabs) {
    const link = places(page).getByRole("link", { name: tab.name, exact: true });
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${tab.path}$`));
    await expect(page.getByRole("heading", { level: 1, name: tab.title })).toBeVisible();
    await expect(link).toHaveAttribute("aria-current", "page");
    await expectNavPlacement(page, testInfo.project.name);
  }

  for (const tab of tabs) {
    await expectTapTarget(places(page).getByRole("link", { name: tab.name, exact: true }));
  }
  await expectTapTarget(accountButton(page));

  // On desktop the account button sits at the foot of the rail; on a phone, in the top bar.
  const navBox = await places(page).boundingBox();
  const accountBox = await accountButton(page).boundingBox();
  if (!navBox || !accountBox) throw new Error("no navigation or account box");
  if (isDesktop(testInfo.project.name)) {
    await expect(places(page).getByRole("link", { name: "Sign in" })).toBeVisible();
    expect(accountBox.y).toBeGreaterThan(navBox.y + navBox.height / 2);
  } else {
    await expect(page.getByRole("banner").getByRole("link", { name: "Sign in" })).toBeVisible();
    expect(accountBox.y).toBeLessThan(100);
  }
});

test("the sign-in screen adds a back button beside the navigation", async ({ page }, testInfo) => {
  await page.goto("/week");
  await accountButton(page).click();

  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole("heading", { level: 1, name: "Editor sign-in" })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("Signing in isn’t available yet.");
  const back = page.getByRole("button", { name: "Back" });
  await expect(back).toBeVisible();
  await expectTapTarget(back);
  await expect(places(page)).toBeVisible();
  await expectNavPlacement(page, testInfo.project.name);

  await back.click();
  await expect(page).toHaveURL(/\/week$/);
  await expect(page.getByRole("button", { name: "Back" })).toHaveCount(0);
});

test("back goes to Recipes when sign-in was opened directly", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/recipes$/);
});

test("the Plateful tokens follow the colour scheme", async ({ page }, testInfo) => {
  const scheme = testInfo.project.use.colorScheme === "dark" ? "dark" : "light";
  await page.goto("/recipes");

  await expect(page.locator("body")).toHaveCSS("background-color", backgrounds[scheme]);
  const tokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const get = (name: string) => style.getPropertyValue(name).trim().toLowerCase();
    return {
      accent: get("--accent"),
      emphasis: get("--emphasis"),
      card: get("--radius-card"),
      button: get("--radius-button"),
      pill: get("--radius-pill"),
    };
  });
  expect(tokens).toEqual({
    accent: scheme === "dark" ? "#8cc5a2" : "#2e5e45",
    emphasis: scheme === "dark" ? "#f07b6b" : "#c2362b",
    card: "24px",
    button: "18px",
    pill: "999px",
  });

  await expect(page.getByRole("heading", { level: 1 })).toHaveCSS("font-family", /Baloo 2/);
  await expect(page.locator("body")).toHaveCSS("font-family", /Nunito Sans/);
  const loaded = await page.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.check('700 23px "Baloo 2"') && document.fonts.check('16px "Nunito Sans"');
  });
  expect(loaded).toBe(true);
  await expect(page.locator('link[href*="fonts.googleapis.com"]')).toHaveCount(0);
});

test("buttons have no borders and the button radius", async ({ page }) => {
  await page.goto("/sign-in");
  const back = page.getByRole("button", { name: "Back" });
  await expect(back).toHaveCSS("border-top-width", "0px");
  await expect(back).toHaveCSS("border-top-left-radius", "18px");
});

test("animations are toned down under reduced motion", async ({ page }) => {
  const duration = async () => {
    const link = places(page).getByRole("link", { name: "Week", exact: true });
    const value = await link.evaluate((el) => getComputedStyle(el).transitionDuration);
    return Math.max(...value.split(",").map((s) => Number.parseFloat(s)));
  };

  await page.goto("/recipes");
  expect(await duration()).toBeGreaterThan(0.1);

  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await duration()).toBeLessThan(0.01);
});

test("the app installs as Plateful", async ({ page, request }) => {
  await page.goto("/recipes");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).toBeTruthy();

  const manifest = await (await request.get(`/${href?.replace(/^\//, "")}`)).json();
  expect(manifest).toMatchObject({ name: "Plateful", short_name: "Plateful" });
  const icons: { src: string; sizes: string; purpose?: string }[] = manifest.icons;
  expect(icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  expect(icons.some((i) => i.purpose === "maskable")).toBe(true);
  for (const icon of icons) {
    const response = await request.get(`/${icon.src.replace(/^\//, "")}`);
    expect(response.ok(), icon.src).toBe(true);
  }

  const touch = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
  expect((await request.get(touch ?? "/missing")).ok()).toBe(true);

  // The fonts are precached so the app keeps its look offline.
  expect(await (await request.get("/sw.js")).text()).toContain(".woff2");
});

test("search engines are told not to index the app", async ({ page, request }) => {
  await page.goto("/fridge");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");

  const robots = await request.get("/robots.txt");
  expect(robots.ok()).toBe(true);
  expect(await robots.text()).toMatch(/User-agent: \*\s+Disallow: \/\s*$/);
});

test("the service worker leaves robots.txt alone", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Playwright's WebKit has no service workers");
  await page.goto("/recipes");
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

  await page.goto("/robots.txt");
  await expect(page.locator("body")).toContainText("Disallow: /");
  await expect(page.locator("#root")).toHaveCount(0);
});
