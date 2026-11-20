import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, type TestInfo, test } from "@playwright/test";

// The local API's fake sign-in, fake web and service token (backend/src/recipes/local.py) aren't
// on a deployed stack.
test.skip(!!process.env.E2E_BASE_URL, "needs the local API's fake sign-in, fake web and token");

// In Playwright's WebKit, page.route stops seeing requests once the app registers a service worker.
test.use({ serviceWorkers: "block" });

const SERVICE_TOKEN = { "x-plateful-service-token": "local-dev-service-token" };
// The FDC Snapshot release the API has: the committed snapshot's file name, minus its extension.
const FDC_DIR = fileURLToPath(new URL("../../backend/src/recipes/data", import.meta.url));
const FDC_RELEASE = (readdirSync(FDC_DIR).find((f) => f.endsWith(".json.gz")) ?? "").replace(
  ".json.gz",
  "",
);
// Garlic, raw (SR Legacy) in the FDC Snapshot; the seed's garlic Canonical Ingredient is Confirmed.
const RAW_GARLIC = /^Garlic, raw · SR Legacy/;

const parse = (low: number, unit: string, name: string) => ({
  provenance: "parser",
  confidence: 0.9,
  estimated: false,
  quantity: { low, high: low },
  unit,
  unit_kind: "volume",
  name,
  preparation: null,
});
const uses = (...refs: string[]) => ({
  provenance: "llm",
  confidence: 0.8,
  estimated: false,
  uses: refs.map((ref) => ({ ref, portion: 1 })),
});

// The fake web's recipe (2 cups cooked rice, 1 tbsp olive oil, 1 tsp kosher salt; Warm the oil
// in a pan; Add the rice and salt, and stir until hot) enriched and every fact confirmed, so it's
// Ready with no Our Version. Each project and attempt has its own, as they share one local API.
async function readyRecipe(page: Page, { project, retry, repeatEachIndex }: TestInfo) {
  const signedIn = await page.request.post("/api/session", {
    data: { credential: "fake:editor@example.com" },
  });
  expect(signedIn.ok(), "fake sign-in").toBe(true);
  const url = `https://plateful.test/our-pilaf-${project.name}-r${retry}-e${repeatEachIndex}`;
  const ingested = await page.request.post("/api/ingest", { data: { url } });
  expect(ingested.status(), "ingest").toBe(200);
  const { source, original } = await ingested.json();
  const saved = await page.request.post("/api/recipes", { data: { source, original, tags: [] } });
  expect(saved.status(), "save").toBe(201);
  const { id } = await saved.json();
  const enriched = await page.request.put(`/api/recipes/${id}/enrichment`, {
    headers: SERVICE_TOKEN,
    data: {
      enrichment_version: 1,
      fdc_release: FDC_RELEASE,
      facts: {
        ingredients: {
          i1: { parse: parse(2, "cup", "cooked rice") },
          i2: { parse: parse(1, "tbsp", "olive oil") },
          i3: { parse: parse(1, "tsp", "kosher salt") },
        },
        steps: { s1: { uses: uses("i2") }, s2: { uses: uses("i1", "i3") } },
      },
      issues: [],
      canonical_ingredients: [],
      wordings: [],
    },
  });
  expect(enriched.status(), await enriched.text()).toBe(200);
  const confirmed = await page.request.post(`/api/recipes/${id}/confirm`, {
    data: {
      version: (await enriched.json()).version,
      fact_ids: ["i1.parse", "i2.parse", "i3.parse", "s1.uses", "s2.uses"],
    },
  });
  expect(confirmed.status(), await confirmed.text()).toBe(200);
  const recipe = await page.request.get(`/api/recipes/${id}`);
  expect((await recipe.json()).status).toBe("ready");
  return id as string;
}

const panel = (page: Page, name: string) => page.getByRole("tabpanel", { name });
const line = (page: Page, name: string) =>
  panel(page, "Ingredients").getByRole("listitem").filter({ hasText: name });
const save = (page: Page) => page.getByRole("button", { name: /^Save \d+ changes?$/ });

test("an editor edits Our Version in Edit, sees it marked, and removes it", async ({
  page,
}, testInfo) => {
  const id = await readyRecipe(page, testInfo);
  await page.goto(`/recipes/${id}`);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const ours = page.getByRole("group", { name: "Our Version" });

  // Less salt, no oil, and garlic added at the end.
  await ours.getByRole("button", { name: "Edit 1 tsp kosher salt" }).click();
  let sheet = page.getByRole("dialog", { name: "Edit 1 tsp kosher salt" });
  await expect(sheet.getByRole("textbox", { name: "Amount" })).toHaveValue("1");
  await sheet.getByRole("textbox", { name: "Amount" }).fill("1/2");
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toBeHidden();
  await expect(ours.getByRole("listitem").filter({ hasText: "½ tsp kosher salt" })).toContainText(
    "Changed",
  );
  await ours.getByRole("button", { name: "Remove 1 tbsp olive oil" }).click();
  await expect(ours.getByRole("listitem").filter({ hasText: "olive oil" })).toContainText(
    "Removed",
  );

  await ours.getByRole("button", { name: "Add a line", exact: true }).click();
  sheet = page.getByRole("dialog", { name: "Add a line" });
  await sheet.getByRole("textbox", { name: "Amount" }).fill("2");
  await sheet.getByRole("textbox", { name: "Name" }).fill("garlic cloves");
  await sheet.getByRole("textbox", { name: "Find or create one" }).fill("garlic");
  const choice = (name: string | RegExp) =>
    sheet.locator("label", { has: page.getByRole("radio", { name, exact: true }) });
  await choice("garlic").click();
  await sheet.getByRole("textbox", { name: "Find an FDC food" }).fill("garlic raw");
  await choice(RAW_GARLIC).click();
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toBeHidden();
  await expect(ours.getByRole("listitem").filter({ hasText: "2 garlic cloves" })).toContainText(
    "Added",
  );

  // A step in Our Version's words, and a note.
  await ours
    .getByRole("button", { name: "Edit Add the rice and salt, and stir until hot." })
    .click();
  sheet = page.getByRole("dialog", { name: /^Edit Add the rice/ });
  await sheet
    .getByRole("textbox", { name: "Step" })
    .fill("Add the rice, salt and garlic, and stir until hot.");
  await sheet.getByRole("button", { name: "Done" }).click();
  await ours.getByRole("textbox", { name: "Note" }).fill("Less salt, and garlic for the oil.");
  await expect(save(page)).toHaveText("Save 1 change");
  await save(page).click();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();

  // The recipe shows Our Version, marked.
  await expect(line(page, "kosher salt").locator(".ingredient-amount")).toHaveText("½ tsp");
  await expect(line(page, "kosher salt")).toContainText("was 1 tsp");
  await expect(line(page, "garlic cloves")).toContainText("added in Our Version");
  await expect(line(page, "olive oil")).toHaveCount(0);
  await page.getByRole("tab", { name: /^Steps/ }).click();
  const second = panel(page, "Steps").getByRole("listitem").nth(1);
  await expect(second).toContainText("Add the rice, salt and garlic, and stir until hot.");
  await expect(second).toContainText("changed in Our Version");
  await page.getByRole("tab", { name: /^About/ }).click();
  await expect(panel(page, "About")).toContainText("Less salt, and garlic for the oil.");

  // Adjust shows the Original.
  await page.getByRole("button", { name: /^Adjust/ }).click();
  const adjust = page.getByRole("dialog", { name: "Adjust" });
  await adjust.getByRole("button", { name: "Original", exact: true }).click();
  await adjust.getByRole("button", { name: "Done" }).click();
  await page.getByRole("tab", { name: /^Ingredients/ }).click();
  await expect(line(page, "olive oil")).toHaveCount(1);
  await expect(line(page, "garlic cloves")).toHaveCount(0);
  await expect(line(page, "kosher salt").locator(".ingredient-amount")).toHaveText("1 tsp");

  // Remove Our Version, after a confirm.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await ours.getByRole("button", { name: "Remove Our Version" }).click();
  await expect(ours).toContainText("Saving removes Our Version");
  await save(page).click();
  await expect(page.getByRole("button", { name: /^Adjust/ })).toBeVisible();
  await expect(line(page, "olive oil")).toHaveCount(1);
  await expect(line(page, "garlic cloves")).toHaveCount(0);
  const stored = await page.request.get(`/api/recipes/${id}`);
  expect((await stored.json()).our_version).toBeNull();
});
