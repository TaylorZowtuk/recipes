import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type Collection, type Recipe } from "./api/client";
import {
  canonicalNote,
  difficultyEdit,
  lineDraft,
  lineEdit,
  numberText,
  readNumber,
  stepDraft,
  stepEdit,
  substitutionEdit,
} from "./factEdits";
import { reviewCounts } from "./needsReview";
import { Ingredients, Steps } from "./RecipeScreen";
import { ItemDetail, NewCanonicalNote, ReviewBar } from "./ReviewSheet";
import {
  confirmableOn,
  confirmItems,
  READY_TOAST,
  reviewItems,
  reviewLeft,
  reviewOf,
  runEdit,
  runReview,
  tabCounts,
  undoBatch,
} from "./review";

const reloadCollection = vi.fn(async () => true);
const rememberRecipe = vi.fn();
vi.mock("./collection", () => ({
  forgetCollection: () => {},
  reloadCollection: () => reloadCollection(),
  rememberRecipe: (recipe: Recipe) => rememberRecipe(recipe),
}));

const stamp = (confirmed: boolean) => ({
  provenance: "llm" as const,
  confidence: 0.7,
  estimated: false,
  confirmed,
  confirmed_by: confirmed ? "editor" : null,
  confirmed_at: confirmed ? "2026-11-01T00:00:00Z" : null,
  confirm_batch: confirmed ? "01K7TESTBATCH0000000000000" : null,
});

const parse = (name: string, confirmed = false, unit: string | null = null) => ({
  ...stamp(confirmed),
  provenance: "parser" as const,
  confidence: 0.9,
  quantity: { low: 2, high: 2 },
  unit,
  unit_kind: null,
  name,
  short_name: null,
  preparation: null,
  comment: null,
  optional: false,
});

const per100g = { kcal: 700, protein_g: 1, fat_g: 80, carbs_g: 0, sodium_mg: 600 };
const conversion = (confirmed: boolean, fields: object) => ({
  ...stamp(confirmed),
  provenance: "fdc" as const,
  confidence: 0.8,
  fdc_id: 1001,
  dataset: "sr_legacy" as const,
  release: "2018-04",
  density_g_per_ml: null,
  grams_per_count: null,
  count_unit: null,
  refused: null,
  per_100g: per100g,
  ...fields,
});

const NEW_CANONICAL = "01K7TESTCANON0000000000001";
const KNOWN_CANONICAL = "01K7TESTCANON0000000000002";
const match = (canonical_id: string, confirmed: boolean) => ({
  ...stamp(confirmed),
  canonical_id,
  fdc_id: 1001,
  portion_id: null,
});

// A synthetic recipe Awaiting Review: i1 flagged on its match to a new Canonical Ingredient, i2
// confirmed, i3 and its substitutions unchecked, i4 with no facts, s1 unchecked, and a suggestion.
const recipe = (fields: Partial<Recipe> = {}): Recipe =>
  ({
    id: "01K7TEST000000000000000001",
    version: 4,
    status: "awaiting_review",
    difficulty: null,
    tags: [],
    images: [],
    preview: null,
    original: {
      title: "Synthetic Test Beans",
      description: null,
      author: null,
      extractor: "json-ld",
      ingredients: [
        { id: "i1", text: "2 tbsp butter", component: null },
        { id: "i2", text: "2 cloves garlic", component: null },
        { id: "i3", text: "2 cups flour or rice flour", component: null },
        { id: "i4", text: "salt", component: null },
      ],
      steps: [
        { id: "s1", text: "Melt the butter.", component: null },
        { id: "s2", text: "Serve.", component: null },
      ],
      yield: null,
      stated_times: { prep: null, cook: null, total: null },
    },
    facts: {
      ingredients: {
        i1: {
          parse: parse("butter", false, "tbsp"),
          match: match(NEW_CANONICAL, false),
          conversion: conversion(false, { density_g_per_ml: 0.96 }),
          substitutions: null,
        },
        i2: {
          parse: parse("garlic", true, "cloves"),
          match: match(KNOWN_CANONICAL, true),
          conversion: conversion(true, { refused: "no weight per clove in FDC" }),
          substitutions: null,
        },
        i3: {
          parse: parse("flour", false, "cups"),
          match: null,
          conversion: null,
          substitutions: {
            ...stamp(false),
            items: [
              {
                wording: "rice flour",
                canonical_id: KNOWN_CANONICAL,
                ratio: 0.75,
                note: "use a little less",
                fdc_id: 2,
                portion_id: null,
                fdc: {
                  dataset: "foundation",
                  release: "2025-04",
                  per_100g: per100g,
                  density_g_per_ml: 0.5,
                  count_unit: null,
                  grams_per_count: null,
                  refused: null,
                },
              },
            ],
          },
        },
        i4: { parse: null, match: null, conversion: null, substitutions: null },
      },
      steps: {
        s1: {
          segments: {
            ...stamp(false),
            segments: [
              { t: "text", v: "Melt " },
              { t: "ingredient", ref: "i1", written: "the butter", portion: 1 },
              { t: "text", v: "." },
            ],
          },
          uses: { ...stamp(false), uses: [{ ref: "i1", portion: 1 }] },
        },
      },
      difficulty: { ...stamp(false), prep: 2, cook: 1, cleanup: 1 },
    },
    issues: [
      {
        id: "01K7TESTISSUE000000000001",
        fact_id: "i1.match",
        before: "margarine",
        after: "butter",
        reason: "The line says butter.",
        status: "open",
        confirm_batch: null,
        model: "test",
      },
      {
        id: "01K7TESTISSUE000000000002",
        fact_id: "i2.parse",
        before: "garlics",
        after: "garlic",
        reason: "Already settled.",
        status: "resolved",
        confirm_batch: "01K7TESTBATCH0000000000000",
        model: "test",
      },
    ],
    ...fields,
  }) as Recipe;

const collection = {
  canonical_ingredients: [
    {
      id: NEW_CANONICAL,
      name: "butter",
      family: "dairy",
      store_category_id: "dairy-eggs",
      pantry_staple: false,
      confirmed: false,
      confirm_batch: null,
      schema_version: 1,
      version: 1,
    },
    {
      id: KNOWN_CANONICAL,
      name: "garlic",
      family: "allium",
      store_category_id: "produce",
      pantry_staple: false,
      confirmed: true,
      confirm_batch: null,
      schema_version: 1,
      version: 1,
    },
  ],
  kitchen_settings: {
    schema_version: 1,
    version: 1,
    store_categories: [
      { id: "produce", name: "Produce" },
      { id: "dairy-eggs", name: "Dairy & Eggs" },
    ],
  },
  wordings: [],
  cards: [],
  collection_version: 1,
} as unknown as Collection;

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("reviewItems", () => {
  it("groups the facts the recipe has into Review Items, as the API does", () => {
    expect(reviewItems(recipe())).toEqual({
      i1: ["i1.parse", "i1.match", "i1.conversion"],
      i2: ["i2.parse", "i2.match", "i2.conversion"],
      i3: ["i3.parse"],
      "i3.substitutions": ["i3.substitutions"],
      s1: ["s1.segments", "s1.uses"],
      difficulty: ["difficulty"],
    });
  });

  it("leaves out a step with only segments' uses missing, but keeps what it has", () => {
    const facts = recipe().facts;
    const s1 = facts.steps.s1;
    if (!s1) throw new Error("fixture");
    const items = reviewItems(
      recipe({ facts: { ...facts, steps: { s1: { ...s1, segments: null } } } }),
    );
    expect(items.s1).toEqual(["s1.uses"]);
  });

  it("leaves out the suggested Difficulty when the editor set the recipe's own", () => {
    const own = recipe({ difficulty: { prep: 1, cook: 1, cleanup: 1 } });
    expect(reviewItems(own).difficulty).toBeUndefined();
    expect(tabCounts(reviewOf(own)).about).toBe(0);
  });
});

describe("reviewOf", () => {
  const items = reviewOf(recipe());
  const mark = (id: string) => items.get(id)?.mark;

  it("marks an item flagged by an open Enrichment Issue, unchecked or confirmed", () => {
    expect(mark("i1")).toBe("flagged");
    expect(mark("i2")).toBe("confirmed");
    expect(mark("i3")).toBe("unchecked");
    expect(mark("i3.substitutions")).toBe("unchecked");
    expect(mark("s1")).toBe("unchecked");
    expect(mark("difficulty")).toBe("unchecked");
    expect(items.has("i4")).toBe(false);
  });

  it("puts lines and substitutions on Ingredients, steps on Steps and the suggestion on About", () => {
    expect(tabCounts(items)).toEqual({ ingredients: 3, steps: 1, about: 1 });
  });

  it("gives a flagged item its open issue's fact as well as its own", () => {
    expect(items.get("i1")?.factIds).toEqual(["i1.parse", "i1.match", "i1.conversion"]);
    expect(items.get("i1")?.issues.map((issue) => issue.before)).toEqual(["margarine"]);
  });

  it("Confirm N on this tab takes every unchecked item's facts, never a flagged one's", () => {
    expect(confirmableOn(items, "ingredients")).toEqual(["i3.parse", "i3.substitutions"]);
    expect(confirmableOn(items, "steps")).toEqual(["s1.segments", "s1.uses"]);
    expect(confirmableOn(items, "about")).toEqual(["difficulty"]);
  });
});

// Cases the API's test_enrichment_review.py checks too, so the two groupings can't drift apart.
type SharedCase = {
  name: string;
  facts: Record<string, boolean>;
  editor_difficulty: boolean;
  open_issues: string[];
  items: Record<string, string[]>;
  unconfirmed: number;
  flagged: number;
};
const shared: { cases: SharedCase[] } = JSON.parse(
  readFileSync(new URL("../../backend/tests/fixtures/review_items.json", import.meta.url), "utf8"),
);

const oneOfEach = (kind: string, confirmed: boolean): object =>
  ({
    parse: parse("flour", confirmed),
    match: match(KNOWN_CANONICAL, confirmed),
    conversion: conversion(confirmed, {}),
    substitutions: { ...stamp(confirmed), items: [] },
    segments: { ...stamp(confirmed), segments: [] },
    uses: { ...stamp(confirmed), uses: [] },
    difficulty: { ...stamp(confirmed), prep: 2, cook: 1, cleanup: 1 },
  })[kind] ?? {};

const sharedRecipe = (c: SharedCase) => {
  const holders: Record<"i" | "s", Record<string, Record<string, object>>> = { i: {}, s: {} };
  let difficulty: object | null = null;
  for (const [path, confirmed] of Object.entries(c.facts)) {
    const [owner = "", kind = ""] = path.split(".");
    if (path === "difficulty") {
      difficulty = oneOfEach(path, confirmed);
    } else {
      const holder = holders[owner.startsWith("i") ? "i" : "s"];
      holder[owner] = { ...holder[owner], [kind]: oneOfEach(kind, confirmed) };
    }
  }
  return recipe({
    facts: { ingredients: holders.i, steps: holders.s, difficulty } as unknown as Recipe["facts"],
    difficulty: c.editor_difficulty ? { prep: 1, cook: 1, cleanup: 1 } : null,
    issues: c.open_issues.map((fact_id, n) => ({
      id: `01K7TESTISSUE0000000000${n}`,
      fact_id,
      before: null,
      after: null,
      reason: "Unsure.",
      status: "open" as const,
      confirm_batch: null,
      model: "test",
    })),
  });
};

describe.each(shared.cases)("the shared Review Items case: $name", (c) => {
  const shown = sharedRecipe(c);

  it("groups the facts and issues as the API does", () => {
    expect(reviewItems(shown)).toEqual(c.items);
    const items = reviewOf(shown);
    expect(Object.fromEntries([...items].map(([id, item]) => [id, item.factIds]))).toEqual(c.items);
  });

  it("leaves as much to review as the card counts", () => {
    expect(reviewLeft(reviewOf(shown))).toEqual({
      open_issues: c.open_issues.length,
      unconfirmed: c.unconfirmed,
      flagged: c.flagged,
    });
  });

  it("badges each tab with as many items as its review bar counts", () => {
    const items = reviewOf(shown);
    const tabs = ["ingredients", "steps", "about"] as const;
    const bars = Object.fromEntries(tabs.map((tab) => [tab, reviewLeft(items, tab).unconfirmed]));
    expect(tabCounts(items)).toEqual(bars);
  });
});

describe("the review bar on a tab holding every item", () => {
  // Shared case 3: three open issues on three items, one of them the only unconfirmed fact's.
  const c = shared.cases[2] as SharedCase;
  const items = reviewOf(sharedRecipe(c));

  it("counts as the card does", () => {
    const bar = text(
      renderToStaticMarkup(<ReviewBar items={items} tab="ingredients" onConfirm={() => {}} />),
    );
    const card = reviewCounts(c);
    expect(card).toBe("3 to check, incl. 3 flagged");
    expect(bar).toContain(card);
  });

  it("counts only the tab's items", () => {
    expect(reviewLeft(items, "steps")).toEqual({ open_issues: 0, unconfirmed: 0, flagged: 0 });
    expect(renderToStaticMarkup(<ReviewBar items={items} tab="steps" onConfirm={() => {}} />)).toBe(
      "",
    );
  });
});

describe("an open Enrichment Issue on a fact the line lacks", () => {
  const issue = (n: number, fact_id: string) => ({
    id: `01K7TESTISSUE00000000000${n}`,
    fact_id,
    before: null,
    after: null,
    reason: "Unsure.",
    status: "open" as const,
    confirm_batch: null,
    model: "test",
  });
  const items = reviewOf(recipe({ issues: [issue(11, "i3.match"), issue(12, "i4.match")] }));

  it("flags the line's item and adds the issue's fact to what confirming it sends", () => {
    expect(items.get("i3")).toMatchObject({
      tab: "ingredients",
      mark: "flagged",
      factIds: ["i3.parse", "i3.match"],
    });
  });

  it("gives a line with no facts an item of its own", () => {
    expect(items.get("i4")).toMatchObject({
      tab: "ingredients",
      mark: "flagged",
      factIds: ["i4.match"],
    });
  });
});

describe("confirm and undo", () => {
  const post = vi.spyOn(api, "POST");
  beforeEach(() => {
    post.mockReset();
    reloadCollection.mockClear();
    rememberRecipe.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  const answer = (status: number, data?: unknown) =>
    ({
      data,
      error: data ? undefined : { detail: "x" },
      response: new Response(null, { status }),
    }) as never;

  it("confirms the facts at the recipe's version, then offers to undo that Confirm Batch", async () => {
    const confirmed = recipe({ version: 5 });
    post.mockResolvedValueOnce(
      answer(200, { recipe: confirmed, confirm_batch: "01K7TESTBATCH0000000000001", ready: false }),
    );
    const toast = await runReview(() => confirmItems(recipe(), ["i3.parse", "i3.substitutions"]));
    expect(post).toHaveBeenCalledWith("/api/recipes/{recipe_id}/confirm", {
      params: { path: { recipe_id: "01K7TEST000000000000000001" } },
      body: { version: 4, fact_ids: ["i3.parse", "i3.substitutions"] },
    });
    expect(rememberRecipe).toHaveBeenCalledWith(confirmed);
    expect(reloadCollection).toHaveBeenCalled();
    expect(toast).toEqual({ text: "Confirmed.", undo: "01K7TESTBATCH0000000000001" });

    post.mockResolvedValueOnce(answer(200, recipe({ version: 6 })));
    const undone = await runReview(() => undoBatch(confirmed, "01K7TESTBATCH0000000000001"));
    expect(post).toHaveBeenLastCalledWith("/api/recipes/{recipe_id}/confirm-batches/{batch}/undo", {
      params: {
        path: { recipe_id: "01K7TEST000000000000000001", batch: "01K7TESTBATCH0000000000001" },
      },
    });
    expect(undone).toEqual({ text: "Undone." });
  });

  it("says the recipe is now Ready when the confirm made it so, still with Undo", async () => {
    post.mockResolvedValueOnce(
      answer(200, {
        recipe: recipe({ status: "ready" }),
        confirm_batch: "01K7TESTBATCH0000000000002",
        ready: true,
      }),
    );
    const toast = await runReview(() => confirmItems(recipe(), ["difficulty"]));
    expect(toast).toEqual({ text: READY_TOAST, undo: "01K7TESTBATCH0000000000002" });
    expect(READY_TOAST).toMatch(/now Ready.*Grocery List and fridge matching/);
  });

  it("reloads on a stale version, saying the recipe changed elsewhere, with nothing to undo", async () => {
    post.mockResolvedValueOnce(answer(409));
    const toast = await runReview(() => confirmItems(recipe(), ["difficulty"]));
    expect(reloadCollection).toHaveBeenCalled();
    expect(toast).toEqual({
      text: "This recipe changed on another device. Showing the newer version.",
    });
  });

  it("says when Plateful can't be reached", async () => {
    post.mockRejectedValueOnce(new TypeError("offline"));
    const toast = await runReview(() => confirmItems(recipe(), ["difficulty"]));
    expect(reloadCollection).not.toHaveBeenCalled();
    expect(toast).toEqual({ text: "Couldn’t reach Plateful. Try again." });
  });

  it("keeps Undo on the toast when an undo couldn't reach Plateful, so it can be tried again", async () => {
    post.mockRejectedValueOnce(new TypeError("offline"));
    const batch = "01K7TESTBATCH0000000000003";
    const toast = await runReview(() => undoBatch(recipe(), batch), batch);
    expect(toast).toEqual({ text: "Couldn’t reach Plateful. Try again.", undo: batch });

    post.mockResolvedValueOnce(answer(404));
    const gone = await runReview(() => undoBatch(recipe(), batch), batch);
    expect(gone.undo).toBeUndefined();
  });
});

describe("the recipe view, for an editor", () => {
  const items = reviewOf(recipe());
  const open = () => {};
  const newCanonicals = new Set([NEW_CANONICAL]);

  it("marks a line matched to a new Canonical Ingredient as new", () => {
    const markup = renderToStaticMarkup(
      <Ingredients
        original={recipe().original}
        facts={recipe().facts}
        review={{ items, open, newCanonicals }}
      />,
    );
    expect(markup.match(/<li>.*?<\/li>/g)?.filter((li) => li.includes("review-new"))).toEqual([
      expect.stringMatching(/butter<span class="review-new">new<\/span>/),
    ]);
  });

  it("marks each item and makes it a button that opens its sheet", () => {
    const markup = renderToStaticMarkup(
      <Ingredients
        original={recipe().original}
        facts={recipe().facts}
        review={{ items, open, newCanonicals }}
      />,
    );
    expect(markup).toContain("review-mark-flagged");
    expect(markup).toContain("review-mark-confirmed");
    expect(markup).toContain("review-mark-unchecked");
    expect([...markup.matchAll(/<button/g)]).toHaveLength(4);
    // The line without facts is no Review Item.
    expect(markup).toContain("<li>salt</li>");
    // Substitutions show to an editor under their own heading, as hidden until confirmed.
    expect(text(markup)).toMatch(/Substitutions.*hidden until confirmed.*rice flour/);
  });

  it("marks steps too", () => {
    const markup = renderToStaticMarkup(
      <Steps
        original={recipe().original}
        facts={recipe().facts}
        review={{ items, open, newCanonicals }}
      />,
    );
    expect([...markup.matchAll(/review-mark-unchecked/g)]).toHaveLength(1);
    expect(markup).toMatch(/<li [^>]*>Serve\.<\/li>/);
  });

  it("offers Confirm N on this tab, skipping flagged items, and nothing when none are left", () => {
    const bar = text(
      renderToStaticMarkup(<ReviewBar items={items} tab="ingredients" onConfirm={open} />),
    );
    // As on the card: the items left to check, and the flagged ones among them.
    expect(bar).toContain("3 to check, incl. 1 flagged");
    expect(bar).toContain("Confirm 2 on this tab");
    const flaggedOnly = reviewOf(
      recipe({
        facts: { ...recipe().facts, ingredients: { i1: recipe().facts.ingredients.i1 } as never },
      }),
    );
    const markup = renderToStaticMarkup(
      <ReviewBar items={flaggedOnly} tab="ingredients" onConfirm={open} />,
    );
    expect(markup).not.toContain("Confirm");
    expect(text(markup)).toContain("1 to check, incl. 1 flagged");
  });
});

describe("the item sheet", () => {
  const markup = (id: string, r = recipe()) => {
    const item = reviewOf(r).get(id);
    if (!item) throw new Error(`no item ${id}`);
    return renderToStaticMarkup(<ItemDetail item={item} recipe={r} collection={collection} />);
  };
  const detail = (id: string) => text(markup(id));

  it("shows a line's parse, Canonical Ingredient, weight and Enrichment Issue", () => {
    const shown = detail("i1");
    expect(shown).toMatch(/Amount 2 tbsp Name butter parser · confidence 0.9/);
    expect(shown).toMatch(/butter.*dairy.*Dairy &amp; Eggs/);
    expect(shown).toContain("0.96 g/ml");
    expect(shown).toMatch(/fdc.*0\.8/);
    expect(shown).toMatch(/margarine → butter/);
    expect(shown).toContain("The line says butter.");
  });

  it("notes that confirming a new Canonical Ingredient adds it for every recipe", () => {
    const note = (id: string) => {
      const r = recipe();
      const item = reviewOf(r).get(id);
      if (!item) throw new Error(`no item ${id}`);
      return text(
        renderToStaticMarkup(<NewCanonicalNote item={item} recipe={r} collection={collection} />),
      ).trim();
    };
    expect(note("i1")).toBe(
      "butter is a new Canonical Ingredient. Confirming adds butter for every recipe that uses it.",
    );
    expect(note("i2")).toBe("");
    expect(note("i3.substitutions")).toBe("");
  });

  it("says why a weight stays in the written unit", () => {
    expect(detail("i2")).toContain("no weight per clove in FDC");
    expect(detail("i2")).toMatch(/garlic.*allium.*Produce/);
  });

  it("lists substitutions, a step's segments and uses, and the suggested Difficulty", () => {
    expect(detail("i3.substitutions")).toMatch(/rice flour.*0\.75.*use a little less/);
    expect(detail("s1")).toMatch(/the butter.*butter.*× 1/);
    expect(markup("difficulty")).toContain('aria-label="Suggested difficulty: Prep 2 of 3');
  });
});

describe("editing a Review Item", () => {
  const post = vi.spyOn(api, "POST");
  beforeEach(() => {
    post.mockReset();
    reloadCollection.mockClear();
    rememberRecipe.mockClear();
  });

  const answer = (status: number, data?: unknown, detail: unknown = "x") =>
    ({
      data,
      error: data ? undefined : { detail },
      response: new Response(null, { status }),
    }) as never;

  const built = (result: ReturnType<typeof lineEdit>) => {
    if ("problem" in result || result.edit.kind !== "line") throw new Error("not a line edit");
    return result.edit;
  };

  it("reads amounts as an editor types them, and shows them the same way", () => {
    expect(readNumber("2")).toBe(2);
    expect(readNumber(" 1.5 ")).toBe(1.5);
    expect(readNumber("1/2")).toBe(0.5);
    expect(readNumber("1 1/2")).toBe(1.5);
    expect(readNumber("a pinch")).toBeUndefined();
    expect(readNumber("1/0")).toBeUndefined();
    expect(numberText(1.5)).toBe("1 1/2");
    expect(numberText(1 / 3)).toBe("1/3");
    expect(numberText(0.96)).toBe("0.96");
  });

  it("saves a line as the editor reads it, keeping its Canonical Ingredient and weight", () => {
    const draft = lineDraft(recipe(), "i1");
    expect(draft).toMatchObject({ low: "2", high: "", unit: "tbsp", name: "butter" });
    expect(
      built(lineEdit(recipe(), "i1", { ...draft, low: "1 1/2", preparation: "soft" })),
    ).toEqual({
      kind: "line",
      line_id: "i1",
      quantity: { low: 1.5, high: 1.5 },
      unit: "tbsp",
      name: "butter",
      preparation: "soft",
    });
    // No amount, as in "to taste", and a range.
    expect(built(lineEdit(recipe(), "i1", { ...draft, low: "", unit: "" }))).toMatchObject({
      quantity: null,
      unit: null,
    });
    expect(built(lineEdit(recipe(), "i1", { ...draft, high: "3" }))).toMatchObject({
      quantity: { low: 2, high: 3 },
    });
  });

  it("refuses a line it can't save, saying why", () => {
    const draft = lineDraft(recipe(), "i1");
    expect(lineEdit(recipe(), "i1", { ...draft, low: "lots" })).toEqual({
      problem: "Give the amount as a number, such as 2, 1.5 or 1 1/2, or leave it empty.",
    });
    expect(lineEdit(recipe(), "i1", { ...draft, high: "1" })).toEqual({
      problem: "The amount’s upper end can’t be below its lower end.",
    });
    expect(lineEdit(recipe(), "i1", { ...draft, name: " " })).toEqual({
      problem: "Give the ingredient a name.",
    });
    expect(
      lineEdit(recipe(), "i1", {
        ...draft,
        canonical: { kind: "new", name: "salted butter", family: "", storeCategoryId: "" },
      }),
    ).toEqual({ problem: "Give the new Canonical Ingredient a family and a Store Category." });
  });

  it("sends a chosen or new Canonical Ingredient, and a weight choice only when it changed", () => {
    const draft = lineDraft(recipe(), "i1");
    expect(
      built(
        lineEdit(recipe(), "i1", {
          ...draft,
          canonical: { kind: "existing", id: KNOWN_CANONICAL },
        }),
      ).canonical,
    ).toEqual({ kind: "existing", id: KNOWN_CANONICAL });
    expect(
      built(
        lineEdit(recipe(), "i1", {
          ...draft,
          canonical: {
            kind: "new",
            name: " salted butter ",
            family: "Dairy",
            storeCategoryId: "dairy-eggs",
          },
        }),
      ).canonical,
    ).toEqual({
      kind: "new",
      name: "salted butter",
      family: "dairy",
      store_category_id: "dairy-eggs",
    });
    expect(draft.keepWeight).toBe(false);
    expect(built(lineEdit(recipe(), "i1", draft))).not.toHaveProperty("keep_weight");
    expect(built(lineEdit(recipe(), "i1", { ...draft, keepWeight: true })).keep_weight).toBe(true);
  });

  it("says a new Canonical Ingredient applies to every recipe with the wording, without a weight", () => {
    const draft = lineDraft(recipe(), "i1");
    expect(canonicalNote(draft, collection)).toBeNull();
    expect(
      canonicalNote({ ...draft, canonical: { kind: "existing", id: KNOWN_CANONICAL } }, collection),
    ).toBe(
      "Saving matches every line worded “butter” to garlic, in every recipe. Without another line matched to garlic with an FDC food, this line has no weight or nutrition.",
    );
    expect(
      canonicalNote(
        {
          ...draft,
          canonical: { kind: "new", name: "salted butter", family: "dairy", storeCategoryId: "" },
        },
        collection,
      ),
    ).toBe(
      "Saving matches every line worded “butter” to salted butter, in every recipe. With no FDC food yet, the line has no weight or nutrition.",
    );
  });

  it("saves a step's portions and timers", () => {
    const r = recipe();
    const s1 = r.facts.steps.s1;
    if (!s1?.segments) throw new Error("fixture");
    const timed = recipe({
      facts: {
        ...r.facts,
        steps: {
          s1: {
            ...s1,
            segments: {
              ...s1.segments,
              segments: [
                ...s1.segments.segments,
                { t: "duration", written: "5 to 7 minutes", low_s: 300, high_s: 420 },
              ],
            },
          },
        },
      },
    });
    const draft = stepDraft(timed, "s1");
    expect(draft).toEqual({ portions: ["1"], timers: [{ low: "5", high: "7" }] });
    expect(stepEdit("s1", { portions: ["1/2"], timers: [{ low: "4", high: "4.5" }] })).toEqual({
      edit: {
        kind: "step",
        step_id: "s1",
        portions: [0.5],
        durations: [{ low_s: 240, high_s: 270 }],
      },
    });
    expect(stepEdit("s1", { portions: ["2"], timers: [] })).toEqual({
      problem: "Give each portion as a number above 0 and at most 1, such as 1/2.",
    });
    expect(stepEdit("s1", { portions: ["1"], timers: [{ low: "5", high: "2" }] })).toEqual({
      problem: "Give each timer in minutes above 0, its upper end not below its lower end.",
    });
  });

  it("saves or removes a substitute, and saves the Difficulty", () => {
    expect(substitutionEdit("i3", 0, "0.5", " half as much ")).toEqual({
      edit: { kind: "substitution", line_id: "i3", index: 0, ratio: 0.5, note: "half as much" },
    });
    expect(substitutionEdit("i3", 0, "11", "")).toEqual({
      problem: "Give the ratio as a number above 0 and at most 10.",
    });
    expect(difficultyEdit({ prep: 1, cook: 2, cleanup: 3 })).toEqual({
      edit: { kind: "difficulty", prep: 1, cook: 2, cleanup: 3 },
    });
    expect(difficultyEdit({ prep: 1 })).toEqual({ problem: "Rate all of Prep, Cook and Cleanup." });
  });

  it("posts the edit at the recipe's version and shows the saved recipe, Confirmed, with no Undo", async () => {
    const saved = recipe({ version: 5 });
    post.mockResolvedValueOnce(answer(200, { recipe: saved, ready: false, also_updated: [] }));
    const edit = { kind: "remove_substitution" as const, line_id: "i3", index: 0 };
    expect(await runEdit(recipe(), edit)).toEqual({ toast: { text: "Saved as Confirmed." } });
    expect(post).toHaveBeenCalledWith("/api/recipes/{recipe_id}/edit", {
      params: { path: { recipe_id: "01K7TEST000000000000000001" } },
      body: { version: 4, edit },
    });
    expect(rememberRecipe).toHaveBeenCalledWith(saved);
    expect(reloadCollection).toHaveBeenCalled();

    post.mockResolvedValueOnce(
      answer(200, { recipe: saved, ready: true, also_updated: ["01K7TEST000000000000000002"] }),
    );
    expect(await runEdit(recipe(), edit)).toEqual({
      toast: {
        text: "Saved as Confirmed. This recipe is now Ready, so it joins the Grocery List and fridge matching. 1 other recipe with the same wording changed too.",
      },
    });
  });

  it("reloads on a stale version, saying the recipe changed elsewhere", async () => {
    post.mockResolvedValueOnce(answer(409));
    const toast = await runEdit(recipe(), { kind: "difficulty", prep: 1, cook: 1, cleanup: 1 });
    expect(reloadCollection).toHaveBeenCalled();
    expect(rememberRecipe).not.toHaveBeenCalled();
    expect(toast).toEqual({
      toast: { text: "This recipe changed on another device. Showing the newer version." },
    });
  });

  it("keeps the form open with the reason when the API refuses the edit or can't be reached", async () => {
    post.mockResolvedValueOnce(answer(422, undefined, "The steps use more than all of i1"));
    const edit = { kind: "step" as const, step_id: "s1", portions: [1], durations: [] };
    expect(await runEdit(recipe(), edit)).toEqual({ problem: "The steps use more than all of i1" });
    post.mockRejectedValueOnce(new TypeError("offline"));
    expect(await runEdit(recipe(), edit)).toEqual({
      problem: "Couldn’t reach Plateful. Try again.",
    });
    expect(reloadCollection).not.toHaveBeenCalled();
  });

  it("says plainly when a line's Canonical Ingredient has no FDC food", () => {
    const r = recipe();
    const i2 = r.facts.ingredients.i2;
    if (!i2?.match) throw new Error("fixture");
    const bare = recipe({
      facts: {
        ...r.facts,
        ingredients: {
          ...r.facts.ingredients,
          i2: { ...i2, match: { ...i2.match, fdc_id: null }, conversion: null },
        },
      },
    });
    const item = reviewOf(bare).get("i2");
    if (!item) throw new Error("no item");
    expect(
      text(renderToStaticMarkup(<ItemDetail item={item} recipe={bare} collection={collection} />)),
    ).toContain("No FDC food, so this line has no weight or nutrition.");
  });
});
