import { expect, type Locator, type Page, type TestInfo, test } from "@playwright/test";

const tabs = [
  { name: "Recipes", path: "/recipes", title: "Collection" },
  { name: "Week", path: "/week", title: "Week Plan" },
  { name: "Fridge", path: "/fridge", title: "Fridge" },
  { name: "Sites", path: "/sites", title: "Favorite Sites" },
];

// The colour roles from the Plateful design tokens, per scheme.
const colours = {
  light: {
    "--bg": "#f7f8f5",
    "--surface": "#ffffff",
    "--text": "#1b2420",
    "--text-secondary": "#58645e",
    "--divider": "#d9dfda",
    "--outline-strong": "#7d8a83",
    "--accent": "#2e5e45",
    "--accent-text": "#2e5e45",
    "--on-accent": "#ffffff",
    "--accent-soft": "#e3ece6",
    "--accent-soft-text": "#24513a",
    "--emphasis": "#c2362b",
    "--emphasis-text": "#b02e24",
    "--done": "#2e5e45",
    "--warning": "#f6ebd2",
    "--warning-text": "#6e5210",
    "--cooking-bg": "#f7f8f5",
    "--cooking-text": "#141b18",
    "--cooking-progress": "#2e5e45",
    "--plate-shadow": "rgba(30, 60, 45, 0.22)",
  },
  dark: {
    "--bg": "#121715",
    "--surface": "#1a201d",
    "--text": "#ecefec",
    "--text-secondary": "#a3ada7",
    "--divider": "#2e3833",
    "--outline-strong": "#6e7c75",
    "--accent": "#8cc5a2",
    "--accent-text": "#9ed2b2",
    "--on-accent": "#0f1a14",
    "--accent-soft": "#22312a",
    "--accent-soft-text": "#bfe0cb",
    "--emphasis": "#f07b6b",
    "--emphasis-text": "#f59486",
    "--done": "#8cc5a2",
    "--warning": "#352c17",
    "--warning-text": "#ebcf8a",
    "--cooking-bg": "#101412",
    "--cooking-text": "#eef1ee",
    "--cooking-progress": "#8cc5a2",
    "--plate-shadow": "rgba(0, 0, 0, 0.5)",
  },
};
type Scheme = keyof typeof colours;
type Role = keyof (typeof colours)["light"];

const schemeOf = (testInfo: TestInfo): Scheme =>
  testInfo.project.use.colorScheme === "dark" ? "dark" : "light";

// A role's colour as getComputedStyle reports it, e.g. "#2e5e45" -> "rgb(46, 94, 69)".
function rgb(scheme: Scheme, role: Role) {
  const value = colours[scheme][role];
  if (!value.startsWith("#")) return value;
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

const isDesktop = (projectName: string) => projectName.startsWith("desktop");
const places = (page: Page) => page.getByRole("navigation", { name: "Places" });
const accountButton = (page: Page) => page.getByRole("link", { name: "Sign in" });

async function expectTapTarget(target: Locator) {
  const box = await target.boundingBox();
  expect(box, "tap target is laid out").not.toBeNull();
  expect(box?.width).toBeGreaterThanOrEqual(50);
  expect(box?.height).toBeGreaterThanOrEqual(50);
}

// Makes the screen far taller than the window and scrolls to its foot.
async function scrollLongScreen(page: Page) {
  await page.getByRole("main").evaluate((main) => {
    const filler = document.createElement("div");
    filler.style.height = "3000px";
    main.append(filler);
  });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
}

async function expectNavPlacement(page: Page, projectName: string) {
  const viewport = page.viewportSize();
  const box = await places(page).boundingBox();
  if (!viewport || !box) throw new Error("no viewport or navigation box");
  if (isDesktop(projectName)) {
    // A left rail: flush with the window's left and top edges and as tall as the window.
    expect(box.x).toBe(0);
    expect(box.y).toBe(0);
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

  // The navigation never scrolls away with the screen.
  await scrollLongScreen(page);
  await expectNavPlacement(page, testInfo.project.name);

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

test("focus moves to the new screen's title, but not on the first page load", async ({ page }) => {
  await page.goto("/recipes");
  await expect(page.locator("body")).toBeFocused();

  await places(page).getByRole("link", { name: "Fridge", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Fridge" })).toBeFocused();
});

test("focus stays put when a navigation replaces the screen", async ({ page }) => {
  // The first load's redirect from / to Collection.
  await page.goto("/");
  await expect(page).toHaveURL(/\/recipes$/);
  await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();
  await expect(page.locator("body")).toBeFocused();

  // A tap on the current place.
  await page.goto("/fridge");
  await places(page).getByRole("link", { name: "Fridge", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Fridge" })).not.toBeFocused();
});

test("moving focus to the new screen's title doesn't scroll the window", async ({ page }) => {
  await page.goto("/recipes");
  // A filler outside the app keeps every screen long, so the route change leaves the scroll alone.
  // On phones the top bar scrolls away above it and the click scrolls back, so each click logs where
  // the window sat when it landed, before the navigation and the focus.
  await page.evaluate(() => {
    const filler = document.createElement("div");
    filler.style.height = "3000px";
    document.body.append(filler);
    addEventListener("click", () => Object.assign(window, { clickScrollY: scrollY }), true);
  });
  const clickScrollY = () =>
    page.evaluate(() => (window as unknown as { clickScrollY: number }).clickScrollY);

  for (const { link, title } of [
    { link: places(page).getByRole("link", { name: "Fridge", exact: true }), title: "Fridge" },
    { link: accountButton(page).filter({ visible: true }), title: "Editor sign-in" },
  ]) {
    await page.evaluate(() => window.scrollTo(0, 1500));
    expect(await page.evaluate(() => window.scrollY)).toBe(1500);
    await link.click();
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeFocused();
    // WebKit scrolls a focused element into view after focus() returns, so wait two frames.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    expect(await page.evaluate(() => window.scrollY)).toBe(await clickScrollY());
  }
});

test("the account button is current on the sign-in screen", async ({ page }) => {
  await page.goto("/sign-in");
  const account = accountButton(page).filter({ visible: true });
  await expect(account).toHaveAttribute("aria-current", "page");
  // Both account links, the rail's and the top bar's, whichever is hidden in this layout.
  const links = page.locator('a[href="/sign-in"]');
  await expect(links).toHaveCount(2);
  for (const link of await links.all()) await expect(link).toHaveAttribute("aria-current", "page");
});

test("the current place stands out in its layout's colours", async ({ page }, testInfo) => {
  const scheme = schemeOf(testInfo);
  await page.goto("/week");
  const current = places(page).getByRole("link", { name: "Week", exact: true });
  await expect(current).toHaveAttribute("aria-current", "page");

  if (isDesktop(testInfo.project.name)) {
    // The rail's selected item is an Accent soft fill.
    await expect(current).toHaveCSS("background-color", rgb(scheme, "--accent-soft"));
    await expect(current).toHaveCSS("color", rgb(scheme, "--accent-soft-text"));
  } else {
    // The active tab is an Accent pill around the icon over an Accent label.
    await expect(current.locator(".icon")).toHaveCSS("background-color", rgb(scheme, "--accent"));
    await expect(current.locator(".icon")).toHaveCSS("color", rgb(scheme, "--on-accent"));
    await expect(current.locator("span")).toHaveCSS("color", rgb(scheme, "--accent-text"));
  }
});

test("the rail scrolls to the account button on a short, wide window", async ({ page }) => {
  // A phone in landscape is wide enough for the rail but too short for all of its items.
  await page.setViewportSize({ width: 844, height: 340 });
  await page.goto("/recipes");

  const account = places(page).getByRole("link", { name: "Sign in" });
  await account.scrollIntoViewIfNeeded();
  await expect(account).toBeInViewport({ ratio: 1 });
  await account.click();
  await expect(page).toHaveURL(/\/sign-in$/);
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

  // Back stays in reach on a long screen.
  await scrollLongScreen(page);
  await expect(back).toBeInViewport({ ratio: 1 });
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

test("back stays in the app after re-opening sign-in from sign-in", async ({ page }) => {
  await page.goto("/sign-in");
  // Following a link to the current path replaces the history entry instead of pushing one.
  await page.getByRole("link", { name: "Sign in" }).filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/recipes$/);
});

test("the Plateful tokens follow the colour scheme", async ({ page }, testInfo) => {
  const scheme = schemeOf(testInfo);
  await page.goto("/recipes");

  await expect(page.locator("body")).toHaveCSS("background-color", rgb(scheme, "--bg"));
  await expect(page.locator("body")).toHaveCSS("color", rgb(scheme, "--text"));
  await expect(places(page)).toHaveCSS("background-color", rgb(scheme, "--surface"));

  // Every colour role, compared as the browser resolves it: the build may respell the hex values.
  const expected: Record<string, string> = colours[scheme];
  const roles = await page.evaluate((expected) => {
    const probe = document.body.appendChild(document.createElement("i"));
    const resolve = (colour: string) => {
      probe.style.color = colour;
      return getComputedStyle(probe).color;
    };
    const entries = Object.entries(expected);
    const actual = Object.fromEntries(entries.map(([name]) => [name, resolve(`var(${name})`)]));
    const wanted = Object.fromEntries(entries.map(([name, value]) => [name, resolve(value)]));
    probe.remove();
    return { actual, wanted };
  }, expected);
  expect(roles.actual).toEqual(roles.wanted);

  const shapes = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return ["--radius-card", "--radius-button", "--radius-pill"].map((name) =>
      style.getPropertyValue(name).trim(),
    );
  });
  expect(shapes).toEqual(["24px", "18px", "999px"]);

  await expect(page.getByRole("heading", { level: 1 })).toHaveCSS("font-family", /Baloo 2/);
  await expect(page.locator("body")).toHaveCSS("font-family", /Nunito Sans/);
  // Each family loads a face of its own: check() alone also passes when no face matches at all.
  const faces = await page.evaluate(async () => {
    const fonts = ['700 23px "Baloo 2"', '400 16px "Nunito Sans"'];
    return Promise.all(fonts.map(async (font) => (await document.fonts.load(font)).length));
  });
  expect(faces.map((count) => count > 0)).toEqual([true, true]);
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

test("the fonts load offline from the service worker's cache", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Playwright's WebKit has no service workers");
  await page.goto("/week");
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Week Plan" })).toBeVisible();
  const loaded = await page.evaluate(async () => {
    const fonts = ['700 23px "Baloo 2"', '400 16px "Nunito Sans"'];
    await Promise.allSettled(fonts.map((font) => document.fonts.load(font)));
    return fonts.map((font) => document.fonts.check(font));
  });
  expect(loaded).toEqual([true, true]);
});
