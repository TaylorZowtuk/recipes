import path from "node:path";
import { expect, test } from "@playwright/test";

// Add a page here when a UI change needs before/after screenshots of it. `loaded` is text that
// shows once a page's data has arrived, for pages that render before it does. `editor` signs in
// first (with the local API's fake sign-in), `menu` opens the account menu and `tab` opens that tab. `ingest` fetches
// that path on the local API's fake web in Add a recipe, made unique to the project. `click` presses
// the button with that name last, such as Edit, without saving anything, and `shows` is text that
// shows once it has. `stubConfirm` answers a review confirm as if it made the recipe Ready, writing
// nothing, since every project shares the seeded recipe. `stubWeek` answers every week with a
// fixed plan and stops the clock on a Wednesday, since every project shares the weeks too.
type Shot = {
  name: string;
  path: string;
  ready: string;
  loaded?: string;
  editor?: boolean;
  menu?: boolean;
  ingest?: string;
  tab?: string;
  click?: string | RegExp;
  shows?: string;
  stubConfirm?: boolean;
  stubWeek?: boolean;
};
const REVIEW_RECIPE = "/recipes/01K7SEED000000000000000007/garlic-butter-green-beans";
const planned = (entry: string, recipe_id: string, recipe_title: string, factor = 1) => ({
  entry_id: `01K7SHOT0000000000000000${entry}`,
  recipe_id,
  recipe_title,
  amount: { kind: "scale", factor },
});
const NOODLES = "Sesame Noodles with Crispy Tofu";
const WEEK_PLAN = {
  schema_version: 1,
  week_start: "2026-11-02",
  grocery_ticks: [],
  version: 3,
  days: [
    [planned("E1", "01K7SEED000000000000000002", NOODLES)],
    [],
    [
      planned("E2", "01K7SEED000000000000000002", NOODLES, 1.5),
      planned("E3", "01K7SEED000000000000000007", "Garlic Butter Green Beans", 0.5),
    ],
    [],
    [planned("E4", "01K7SEED000000000000000002", NOODLES, 2)],
    [planned("E5", "01K7GONE000000000000000000", "A Recipe No Longer in the Collection")],
    [],
  ],
};
const pages: Shot[] = [
  {
    name: "recipes",
    path: "/recipes",
    ready: "Collection",
    loaded: "Sesame Noodles with Crispy Tofu",
  },
  {
    name: "recipes-filters",
    path: "/recipes",
    ready: "Collection",
    loaded: "Sesame Noodles with Crispy Tofu",
    click: "Filters",
  },
  { name: "week", path: "/week", ready: "Week Plan" },
  {
    name: "week-editor",
    path: "/week",
    ready: "Week Plan",
    loaded: "Garlic Butter Green Beans",
    editor: true,
    stubWeek: true,
  },
  {
    name: "week-empty-editor",
    path: "/week",
    ready: "Week Plan",
    loaded: "This week",
    editor: true,
    click: "Next week",
    shows: "Next week",
  },
  {
    name: "week-picker",
    path: "/week",
    ready: "Week Plan",
    loaded: "Garlic Butter Green Beans",
    editor: true,
    stubWeek: true,
    click: /^\+ Add to Thu/,
    shows: "Overnight Oats",
  },
  {
    name: "week-scale",
    path: "/week",
    ready: "Week Plan",
    loaded: "Garlic Butter Green Beans",
    editor: true,
    stubWeek: true,
    click: /^Scale Garlic Butter Green Beans/,
    shows: "½×",
  },
  {
    name: "recipes-editor",
    path: "/recipes",
    ready: "Collection",
    loaded: "✓ Mon, Wed, Fri",
    editor: true,
    stubWeek: true,
  },
  {
    name: "recipes-day-sheet",
    path: "/recipes",
    ready: "Collection",
    loaded: "✓ Mon, Wed, Fri",
    editor: true,
    stubWeek: true,
    click: new RegExp(`^✓ Mon, Wed, Fri: ${NOODLES}`),
    shows: "✓ Remove",
  },
  {
    name: "recipe-editor",
    path: "/recipes/01K7SEED000000000000000002/sesame-noodles-with-crispy-tofu",
    ready: NOODLES,
    loaded: "For the sauce",
    editor: true,
  },
  { name: "fridge", path: "/fridge", ready: "Fridge" },
  { name: "sites", path: "/sites", ready: "Favorite Sites", loaded: "Example Kitchen" },
  {
    name: "sites-editor",
    path: "/sites",
    ready: "Favorite Sites",
    loaded: "Example Kitchen",
    editor: true,
  },
  {
    name: "sites-edit",
    path: "/sites",
    ready: "Favorite Sites",
    loaded: "Example Kitchen",
    editor: true,
    click: "Edit",
    shows: "Add a site",
  },
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
    name: "add-recipe-needs-page",
    path: "/add",
    ready: "Add a recipe",
    editor: true,
    ingest: "robots-denied/screenshot-listed-stew",
    loaded:
      "This site doesn’t allow automated fetching, so the recipe needs its page pasted in. It’s in the list below.",
  },
  {
    name: "add-recipe-paste",
    path: "/add",
    ready: "Add a recipe",
    editor: true,
    ingest: "robots-denied/screenshot-stew",
    loaded:
      "This site doesn’t allow automated fetching, so the recipe needs its page pasted in. It’s in the list below.",
    click: /^Paste its page/,
    shows: "The page’s source (HTML)",
  },
  {
    name: "recipe",
    path: "/recipes/01K7SEED000000000000000002/sesame-noodles-with-crispy-tofu",
    ready: "Sesame Noodles with Crispy Tofu",
    loaded: "For the sauce",
  },
  {
    name: "recipe-steps",
    path: "/recipes/01K7SEED000000000000000002/sesame-noodles-with-crispy-tofu",
    ready: "Sesame Noodles with Crispy Tofu",
    loaded: "For the sauce",
    tab: "Steps",
  },
  {
    name: "recipe-edit",
    path: "/recipes/01K7SEED000000000000000002/sesame-noodles-with-crispy-tofu",
    ready: "Sesame Noodles with Crispy Tofu",
    loaded: "For the sauce",
    editor: true,
    click: "Edit",
  },
  {
    name: "recipes-needs-review",
    path: "/recipes",
    ready: "Collection",
    loaded: "Sesame Noodles with Crispy Tofu",
    editor: true,
    click: /^Needs Review · \d+$/,
    shows: "Awaiting Review",
  },
  {
    name: "recipe-review",
    path: REVIEW_RECIPE,
    ready: "Garlic Butter Green Beans",
    loaded: "3 to check, incl. 1 flagged",
    editor: true,
  },
  {
    name: "recipe-review-sheet",
    path: REVIEW_RECIPE,
    ready: "Garlic Butter Green Beans",
    loaded: "3 to check, incl. 1 flagged",
    editor: true,
    click: /^Flagged: butter/,
    shows: "The line says butter, so it is a new Canonical Ingredient, not margarine.",
  },
  {
    name: "recipe-review-ready-toast",
    path: REVIEW_RECIPE,
    ready: "Garlic Butter Green Beans",
    loaded: "3 to check, incl. 1 flagged",
    editor: true,
    tab: "Steps",
    stubConfirm: true,
    click: "Confirm 1 on this tab",
    shows: "Confirmed. This recipe is now Ready, so it joins the Grocery List and fridge matching.",
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

for (const shot of pages) {
  const { name, path: url, ready, loaded, editor, menu, ingest, tab, click, shows } = shot;
  test(name, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("https://accounts.google.com/gsi/client", (route) =>
      route.fulfill({ contentType: "text/javascript", body: fakeGoogle }),
    );
    if (shot.stubConfirm) {
      await page.route("**/api/recipes/*/confirm", async (route) => {
        const id = new URL(route.request().url()).pathname.split("/")[3];
        const recipe = await (await page.request.get(`/api/recipes/${id}`)).json();
        await route.fulfill({
          json: { recipe, confirm_batch: "01K7SHOT00000000000000000B", ready: true },
        });
      });
    }
    if (shot.stubWeek) {
      await page.clock.setFixedTime(new Date(2026, 10, 4, 12));
      await page.route("**/api/weeks/*", (route) => route.fulfill({ json: WEEK_PLAN }));
    }
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
    if (tab) {
      await page.getByRole("tab", { name: tab }).click();
      await expect(page.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
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
      const button = page.getByRole("button", { name: click, exact: true }).first();
      if (mayBeMissing) {
        const shown = await button.waitFor({ timeout: 3000 }).then(
          () => true,
          () => false,
        );
        test.skip(!shown, `no ${click} button on this branch`);
      }
      await button.click();
      if (shows) {
        const shown = page.getByText(shows, { exact: true }).first();
        if (mayBeMissing) await shown.waitFor({ timeout: 3000 }).catch(() => {});
        else await expect(shown).toBeVisible();
      }
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    }
    // Photos load after the data that names them. A full-page shot shows those below the fold too,
    // which WebKit otherwise leaves unloaded.
    await page.evaluate(() => {
      for (const image of document.images) image.loading = "eager";
    });
    await page.waitForFunction(() => Array.from(document.images).every((image) => image.complete));
    expect(errors, "uncaught errors").toEqual([]);
    await page.screenshot({
      path: path.join(outDir, testInfo.project.name, `${name}.png`),
      fullPage: true,
    });
  });
}
