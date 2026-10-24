import { expect, type Page, test } from "@playwright/test";

// The fake credentials work only on the local API (recipes.local), not on a deployed stack.
test.skip(!!process.env.E2E_BASE_URL, "needs the local API's fake sign-in");

const GSI = "https://accounts.google.com/gsi/client";

// In Playwright's WebKit, page.route stops seeing requests once the app registers its service
// worker, and then the real Google script loads instead of the fake.
test.use({ serviceWorkers: "block" });

// Stands in for Google Identity Services: renderButton draws a button that hands the callback
// `credential`. It insists on popup mode, which keeps an installed iOS app's sign-in in the app.
function fakeGoogle(credential: string) {
  return `
    window.google = { accounts: { id: {
      initialize(config) {
        if (config.ux_mode !== "popup") throw new Error("not popup mode: " + config.ux_mode);
        if (config.client_id !== "local-dev-client") throw new Error("client " + config.client_id);
        window.__gsi = config;
      },
      renderButton(parent) {
        const button = document.createElement("button");
        button.textContent = "Sign in with Google";
        button.onclick = () => window.__gsi.callback({ credential: ${JSON.stringify(credential)} });
        parent.replaceChildren(button);
      },
    } } };
  `;
}

async function serveGoogle(page: Page, credential: string) {
  await page.route(GSI, (route) =>
    route.fulfill({ contentType: "text/javascript", body: fakeGoogle(credential) }),
  );
}

const accountButton = (page: Page) => page.getByRole("button", { name: "Account" });
const menu = (page: Page) => page.getByRole("menu", { name: "Account" });
const menuItems = (page: Page) => menu(page).getByRole("menuitem");
const title = (page: Page) => page.getByRole("heading", { level: 1, name: "Editor sign-in" });

async function openMenu(page: Page) {
  await accountButton(page).click();
  await expect(menu(page)).toBeVisible();
}

test("an editor signs in, stays signed in across a reload, and signs out", async ({ page }) => {
  await serveGoogle(page, "fake:editor@example.com");
  await page.goto("/week");

  await openMenu(page);
  await expect(menuItems(page)).toHaveText(["Kitchen settings", "Sign in"]);
  await menu(page).getByRole("menuitem", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Editor sign-in" })).toBeVisible();
  await page.getByRole("button", { name: "Sign in with Google" }).click();

  // Back where sign-in was opened from, as an editor.
  await expect(page).toHaveURL(/\/week$/);
  await openMenu(page);
  await expect(menuItems(page)).toHaveText(["Add a recipe", "Kitchen settings", "Sign out"]);
  await expect(page.getByText("editor@example.com")).toBeVisible();
  await expect(menu(page)).toHaveAccessibleDescription("Signed in as editor@example.com");

  // The session cookie survives a reload, even without the remembered role.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await openMenu(page);
  await expect(menuItems(page)).toHaveText(["Add a recipe", "Kitchen settings", "Sign out"]);

  await menu(page).getByRole("menuitem", { name: "Sign out" }).click();
  await expect(menu(page)).toBeHidden();
  await expect(accountButton(page)).toBeFocused();
  await openMenu(page);
  await expect(menuItems(page)).toHaveText(["Kitchen settings", "Sign in"]);

  // Signed out on the API too, not only on screen.
  await page.reload();
  await openMenu(page);
  await expect(menuItems(page)).toHaveText(["Kitchen settings", "Sign in"]);
});

test("Add a recipe asks a visitor to sign in, then opens for the editor", async ({ page }) => {
  await serveGoogle(page, "fake:editor@example.com");
  await page.goto("/add");
  await expect(page.getByRole("heading", { level: 1, name: "Add a recipe" })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("Only the household’s editors");

  await page.getByRole("main").getByRole("link", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Sign in with Google" }).click();

  await expect(page).toHaveURL(/\/add$/);
  await expect(page.getByRole("textbox", { name: "Recipe web address" })).toBeVisible();
});

test("a Google account that isn't an editor is told so", async ({ page }) => {
  await serveGoogle(page, "fake:stranger@example.com");
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in with Google" }).click();

  await expect(page.getByRole("alert")).toHaveText(
    "This Google account isn’t one of this kitchen’s editors.",
  );
  await expect(page).toHaveURL(/\/sign-in$/);
  await openMenu(page);
  await expect(menuItems(page)).toHaveText(["Kitchen settings", "Sign in"]);
});

test("an unverified Google account isn't let in", async ({ page }) => {
  await serveGoogle(page, "fake-unverified:editor@example.com");
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in with Google" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "This Google account isn’t one of this kitchen’s editors.",
  );
});

test("sign-in says when Google can't be reached, and tries again", async ({ page }) => {
  let reachable = false;
  await page.route(GSI, (route) =>
    reachable
      ? route.fulfill({
          contentType: "text/javascript",
          body: fakeGoogle("fake:editor@example.com"),
        })
      : route.abort("internetdisconnected"),
  );
  await page.goto("/sign-in");
  await expect(page.getByRole("alert")).toHaveText(
    "Couldn’t reach Google. Check your connection and try again.",
  );
  await expect(page.getByText("Loading Google sign-in…")).toHaveCount(0);

  // Focus rests on the title once the retry settles, whether it fails or works.
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Couldn’t reach Google. Check your connection and try again.",
  );
  await expect(title(page)).toBeFocused();

  reachable = true;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(title(page)).toBeFocused();
});

test("sign-in says when it isn't available", async ({ page }) => {
  await serveGoogle(page, "fake:editor@example.com");
  await page.route("**/api/session", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 503, json: { detail: "Sign-in isn't configured" } })
      : route.fallback(),
  );
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in with Google" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Sign-in isn’t available right now. Try again later.",
  );
});

test("sign-in tries again once the session can be loaded", async ({ page }) => {
  await serveGoogle(page, "fake:editor@example.com");
  let reachable = false;
  await page.route("**/api/session", (route) =>
    reachable ? route.fallback() : route.abort("internetdisconnected"),
  );
  await page.goto("/sign-in");
  await expect(page.getByRole("alert")).toHaveText(
    "Sign-in isn’t available right now. Try again later.",
  );

  // Focus rests on the title once the retry settles, whether it fails or works.
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Sign-in isn’t available right now. Try again later.",
  );
  await expect(title(page)).toBeFocused();

  reachable = true;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(title(page)).toBeFocused();
});

test("a retry that settles after leaving sign-in doesn't take focus", async ({ page }) => {
  let hold = false;
  let heldGets = 0;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/session", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    if (!hold) return route.abort("internetdisconnected");
    heldGets++;
    await held;
    return route.fallback();
  });
  await page.goto("/sign-in");
  const tryAgain = page.getByRole("button", { name: "Try again" });
  await expect(tryAgain).toBeVisible();
  hold = true;
  await tryAgain.click();
  await expect.poll(() => heldGets).toBe(1);

  await page
    .getByRole("navigation", { name: "Places" })
    .getByRole("link", { name: "Recipes" })
    .click();
  const search = page.getByRole("searchbox", { name: "Search recipe titles" });
  await search.focus();
  release();
  // Give a stray focusTitle() time to run, then check the search kept focus.
  await page.waitForTimeout(300);
  await expect(search).toBeFocused();
});

test("opening sign-in again retries a session that couldn't be loaded", async ({ page }) => {
  await serveGoogle(page, "fake:editor@example.com");
  let reachable = false;
  await page.route("**/api/session", (route) =>
    reachable ? route.fallback() : route.abort("internetdisconnected"),
  );
  await page.goto("/week");
  await openMenu(page);
  await menu(page).getByRole("menuitem", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();

  reachable = true;
  await openMenu(page);
  await menu(page).getByRole("menuitem", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
});

test("sign-in shows that Google's button and the sign-in are on their way", async ({ page }) => {
  let releaseGoogle = () => {};
  const googleHeld = new Promise<void>((resolve) => {
    releaseGoogle = resolve;
  });
  await page.route(GSI, async (route) => {
    await googleHeld;
    await route.fulfill({
      contentType: "text/javascript",
      body: fakeGoogle("fake:editor@example.com"),
    });
  });
  let releaseSignIn = () => {};
  const signInHeld = new Promise<void>((resolve) => {
    releaseSignIn = resolve;
  });
  await page.route("**/api/session", async (route) => {
    if (route.request().method() === "POST") await signInHeld;
    await route.fallback();
  });

  await page.goto("/sign-in");
  await expect(page.getByText("Loading Google sign-in…")).toBeVisible();
  releaseGoogle();
  await page.getByRole("button", { name: "Sign in with Google" }).click();
  await expect(page.getByText("Loading Google sign-in…")).toHaveCount(0);

  await expect(page.getByRole("main").getByRole("status")).toHaveText("Signing in…");
  releaseSignIn();
  await expect(page).toHaveURL(/\/recipes$/);
});

test("a credential that arrives after leaving sign-in doesn't move the editor", async ({
  page,
}) => {
  await serveGoogle(page, "fake:editor@example.com");
  await page.goto("/recipes");
  await openMenu(page);
  await menu(page).getByRole("menuitem", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();

  // Google's popup is still open when the editor goes elsewhere, then finishes.
  await page
    .getByRole("navigation", { name: "Places" })
    .getByRole("link", { name: "Week" })
    .click();
  await expect(page).toHaveURL(/\/week$/);
  await page.evaluate(() => {
    const gsi = (window as { __gsi?: { callback(r: { credential: string }): void } }).__gsi;
    gsi?.callback({ credential: "fake:editor@example.com" });
  });

  await openMenu(page);
  await expect(menuItems(page)).toHaveText(["Add a recipe", "Kitchen settings", "Sign out"]);
  await expect(page).toHaveURL(/\/week$/);
});

test("Sign out shows it's signing out and ignores another tap", async ({ page }) => {
  await serveGoogle(page, "fake:editor@example.com");
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in with Google" }).click();
  await expect(page).toHaveURL(/\/recipes$/);

  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let deletes = 0;
  await page.route("**/api/session", async (route) => {
    if (route.request().method() === "DELETE") {
      deletes++;
      await held;
    }
    await route.fallback();
  });

  await openMenu(page);
  await menu(page).getByRole("menuitem", { name: "Sign out" }).click();
  const signingOut = menu(page).getByRole("menuitem", { name: "Signing out…" });
  await expect(signingOut).toHaveAttribute("aria-disabled", "true");
  // Playwright won't tap an aria-disabled item, so force it: a person can still tap it.
  await signingOut.click({ force: true });
  release();

  await expect(menu(page)).toBeHidden();
  expect(deletes).toBe(1);
  await openMenu(page);
  await expect(menuItems(page)).toHaveText(["Kitchen settings", "Sign in"]);
});

test("Sign out stays in reach on a very short phone screen", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("desktop"), "the phone's top-bar menu");
  // A 1280×1024 window at 400% zoom.
  await page.setViewportSize({ width: 320, height: 256 });
  await serveGoogle(page, "fake:editor@example.com");
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in with Google" }).click();
  await expect(page).toHaveURL(/\/recipes$/);

  await openMenu(page);
  const signOut = menu(page).getByRole("menuitem", { name: "Sign out" });
  await signOut.scrollIntoViewIfNeeded();
  await expect(signOut).toBeInViewport({ ratio: 1 });
  // Nothing (such as the tab bar) covers it: a click lands on it.
  await signOut.click({ trial: true });
  await signOut.click();
  await expect(menu(page)).toBeHidden();
  await openMenu(page);
  await expect(menuItems(page)).toHaveText(["Kitchen settings", "Sign in"]);
});
