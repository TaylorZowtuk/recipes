import path from "node:path";
import { expect, test } from "@playwright/test";

// Add a page here when a UI change needs before/after screenshots of it. `loaded` is text that
// shows once a page's data has arrived, for pages that render before it does. `editor` signs in
// first (with the local API's fake sign-in), and `menu` opens the account menu. `ingest` fetches
// that path on the local API's fake web in Add a recipe, made unique to the project. `click` presses
// the button with that name last, such as Edit, without saving anything.
type Shot = {
  name: string;
  path: string;
  ready: string;
  loaded?: string;
  editor?: boolean;
  menu?: boolean;
  ingest?: string;
  click?: string;
};
const pages: Shot[] = [
  {
    name: "recipes",
    path: "/recipes",
    ready: "Collection",
    loaded: "Sesame Noodles with Crispy Tofu",
  },
  { name: "week", path: "/week", ready: "Week Plan" },
  { name: "fridge", path: "/fridge", ready: "Fridge" },
  { name: "sites", path: "/sites", ready: "Favorite Sites" },
  { name: "sign-in", path: "/sign-in", ready: "Editor sign-in" },
  { name: "account-menu", path: "/week", ready: "Week Plan", menu: true },
  { name: "account-menu-editor", path: "/week", ready: "Week Plan", menu: true, editor: true },
  { name: "kitchen-settings", path: "/kitchen-settings", ready: "Kitchen settings" },
  { name: "add-recipe", path: "/add", ready: "Add a recipe" },
  { name: "add-recipe-editor", path: "/add", ready: "Add a recipe", editor: true },
  {
    name: "add-recipe-review",
    path: "/add",
    ready: "Add a recipe",
    editor: true,
    ingest: "screenshot-lemon-rice",
    loaded: "3 photos",
  },
  {
    name: "add-recipe-queued",
    path: "/add",
    ready: "Add a recipe",
    editor: true,
    ingest: "blocked/screenshot-soup",
    loaded:
      "The recipe couldn’t be fetched, so it’s waiting for the fallback. It’s in the list below.",
  },
  {
    name: "recipe",
    path: "/recipes/01K7SEED000000000000000002/sesame-noodles-with-crispy-tofu",
    ready: "Sesame Noodles with Crispy Tofu",
    loaded: "For the sauce",
  },
  {
    name: "recipe-edit",
    path: "/recipes/01K7SEED000000000000000002/sesame-noodles-with-crispy-tofu",
    ready: "Sesame Noodles with Crispy Tofu",
    loaded: "For the sauce",
    editor: true,
    click: "Edit",
  },
];

// In Playwright's WebKit, page.route stops seeing requests once the app registers a service worker.
test.use({ serviceWorkers: "block" });

const outDir = process.env.SCREENSHOT_DIR ?? "screenshots-out";
// Set for the base branch's run, which may predate some of the pages.
const mayBeMissing = !!process.env.SCREENSHOT_MAY_BE_MISSING;

// A stand-in for Google's sign-in script, so the sign-in page looks the same on every run. Like the
// real one, it draws the button in an iframe whose document declares no colour scheme.
const fakeGoogle = `window.google = { accounts: { id: {
  initialize() {},
  renderButton(parent, options) {
    const dark = options.theme === "filled_black";
    const f = document.createElement("iframe");
    f.title = "Sign in with Google";
    f.style.cssText = "width:220px;height:52px;border:0";
    f.srcdoc = '<body style="margin:0;background:transparent"><button style="margin:6px;min-height:40px;padding:0 20px;border:1px solid '
      + (dark ? '#131314;background:#131314;color:#e3e3e3' : '#dadce0;background:#fff;color:#3c4043')
      + ';border-radius:20px;font:500 14px system-ui">Sign in with Google</button></body>';
    parent.replaceChildren(f);
  },
} } };`;

for (const { name, path: url, ready, loaded, editor, menu, ingest, click } of pages) {
  test(name, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("https://accounts.google.com/gsi/client", (route) =>
      route.fulfill({ contentType: "text/javascript", body: fakeGoogle }),
    );
    if (editor) {
      const signedIn = await page.request.post("/api/session", {
        data: { credential: "fake:editor@example.com" },
      });
      test.skip(mayBeMissing && !signedIn.ok(), "no sign-in on this branch");
      expect(signedIn.ok(), "fake sign-in").toBe(true);
    }
    await page.goto(url);
    const heading = page.getByRole("heading", { level: 1, name: ready, exact: true });
    if (mayBeMissing) {
      const shown = await heading.waitFor({ timeout: 3000 }).then(
        () => true,
        () => false,
      );
      // Skip only when the app itself rendered. BASE may predate the shell, so the sign is that
      // #root has content and nothing threw, not this branch's navigation.
      expect(errors, "uncaught errors").toEqual([]);
      await expect(page.locator("#root > *").first()).toBeAttached();
      test.skip(!shown, `no "${ready}" heading at ${url}: the page is new`);
    } else {
      await expect(heading).toBeVisible();
    }
    if (ingest) {
      const field = page.getByRole("textbox", { name: "Recipe web address" });
      if (mayBeMissing) {
        const shown = await field.waitFor({ timeout: 3000 }).then(
          () => true,
          () => false,
        );
        test.skip(!shown, "no Add a recipe form on this branch");
      }
      await field.fill(`https://plateful.test/${ingest}-${testInfo.project.name}`);
      await page.getByRole("button", { name: "Fetch" }).click();
    }
    if (loaded) {
      const content = page.getByText(loaded, { exact: true }).first();
      // BASE may show the page without this data yet, so it gets a short wait and no failure.
      if (mayBeMissing) await content.waitFor({ timeout: 3000 }).catch(() => {});
      else await expect(content).toBeVisible();
    }
    if (menu) {
      const account = page.getByRole("button", { name: "Account" });
      if (mayBeMissing) {
        const shown = await account.waitFor({ timeout: 3000 }).then(
          () => true,
          () => false,
        );
        test.skip(!shown, "no account menu on this branch");
      }
      await account.click();
      await expect(page.getByRole("menu", { name: "Account" })).toBeVisible();
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
      if (editor) await expect(page.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
    }
    if (click) {
      const button = page.getByRole("button", { name: click, exact: true });
      if (mayBeMissing) {
        const shown = await button.waitFor({ timeout: 3000 }).then(
          () => true,
          () => false,
        );
        test.skip(!shown, `no ${click} button on this branch`);
      }
      await button.click();
    }
    // Photos load after the data that names them.
    await page.waitForFunction(() => Array.from(document.images).every((image) => image.complete));
    expect(errors, "uncaught errors").toEqual([]);
    await page.screenshot({
      path: path.join(outDir, testInfo.project.name, `${name}.png`),
      fullPage: true,
    });
  });
}
