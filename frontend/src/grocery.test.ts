import { describe, expect, it } from "vitest";
import type {
  CanonicalIngredient,
  ConversionFact,
  Factor,
  IngredientFacts,
  KitchenSettings,
  ParseFact,
  Recipe,
  WeekPlan,
} from "./api/client";
import { type GroceryItem, type GroceryList, groceryList } from "./grocery";

// Synthetic Canonical Ingredients, Store Categories, recipes and Week Plans.

const settings = {
  schema_version: 1,
  version: 1,
  store_categories: [
    { id: "produce", name: "Produce" },
    { id: "aisles", name: "Aisles" },
    { id: "dairy", name: "Dairy" },
  ],
} as KitchenSettings;

const canonical = (id: string, store_category_id: string): CanonicalIngredient =>
  ({ id, name: id, family: id, store_category_id, pantry_staple: false }) as CanonicalIngredient;
const canonicals = [
  canonical("onion", "produce"),
  canonical("garlic", "produce"),
  canonical("parsley", "produce"),
  canonical("flour", "aisles"),
  canonical("tomato", "aisles"),
  canonical("salt", "aisles"),
  canonical("milk", "dairy"),
  canonical("butter", "dairy"),
  canonical("mystery", "gone-category"),
];

const conversion = (fact: Partial<ConversionFact>): ConversionFact =>
  ({
    provenance: "fdc",
    confidence: 0.9,
    estimated: false,
    confirmed: true,
    density_g_per_ml: null,
    grams_per_count: null,
    count_unit: null,
    refused: null,
    ...fact,
  }) as ConversionFact;
const flourDensity = conversion({ density_g_per_ml: 0.5 }); // 1 cup ≈ 118 g
const unchecked = conversion({ density_g_per_ml: 0.5, confirmed: false });

type LineSpec = {
  amount?: number | [number, number] | null;
  unit?: string | null;
  kind?: ParseFact["unit_kind"];
  comment?: string;
  canon?: string | null;
  conv?: ConversionFact;
  unparsed?: boolean;
};
type Line = { id: string; text: string; facts: IngredientFacts };

function line(id: string, text: string, spec: LineSpec): Line {
  const { amount = 1, unit = null, kind = null, comment = null, canon = null } = spec;
  const [low, high] = typeof amount === "number" ? [amount, amount] : (amount ?? [0, 0]);
  const parse = {
    quantity: amount === null ? null : { low, high },
    unit,
    unit_kind: kind,
    name: text,
    comment,
  } as ParseFact;
  return {
    id,
    text,
    facts: {
      parse: spec.unparsed ? null : parse,
      match: canon ? ({ canonical_id: canon } as IngredientFacts["match"]) : null,
      conversion: spec.conv ?? null,
      substitutions: null,
    },
  };
}

function recipe(id: string, lines: Line[], status: Recipe["status"] = "ready"): Recipe {
  return {
    id,
    status,
    our_version: null,
    original: {
      title: `Title ${id}`,
      ingredients: lines.map(({ id, text }) => ({ id, text, component: null })),
      steps: [],
    },
    facts: {
      ingredients: Object.fromEntries(lines.map(({ id, facts }) => [id, facts])),
      steps: {},
    },
  } as unknown as Recipe;
}

type Entry = [recipe: string, factor?: Factor];
// A Week Plan with entries placed on Monday onwards, one day per element.
function plan(days: Entry[][], grocery_ticks: string[] = []): WeekPlan {
  let n = 0;
  return {
    week_start: "2026-11-23",
    schema_version: 1,
    version: 1,
    grocery_ticks,
    days: Array.from({ length: 7 }, (_, day) =>
      (days[day] ?? []).map(([recipe_id, factor = 1]) => ({
        entry_id: `e${++n}`,
        recipe_id,
        recipe_title: `Title ${recipe_id}`,
        amount: { kind: "scale" as const, factor },
      })),
    ),
  };
}

function list(week: WeekPlan, recipes: Recipe[], known: Recipe[] = recipes): GroceryList {
  return groceryList(week, new Map(known.map((r) => [r.id, r])), canonicals, settings);
}

const items = (result: GroceryList): GroceryItem[] => result.categories.flatMap((c) => c.items);
function item(result: GroceryList, key: string): GroceryItem {
  const found = items(result).find((i) => i.key === key);
  if (!found) throw new Error(`no item ${key}`);
  return found;
}
// The single item of a list of one or more recipes on Monday.
function only(...recipes: Recipe[]): GroceryItem {
  const all = items(list(plan([recipes.map((r): Entry => [r.id])]), recipes));
  expect(all).toHaveLength(1);
  return all[0] as GroceryItem;
}

const milk = (id: string, amount: LineSpec["amount"], unit: string) =>
  line("i1", `${id} milk`, { amount, unit, kind: "volume", canon: "milk" });

describe("same kind", () => {
  it("sums volumes exactly", () => {
    const got = only(recipe("a", [milk("a", 1, "cup")]), recipe("b", [milk("b", 2, "tbsp")]));
    expect(got.amount).toBe("1⅛ cups");
    expect(got.fingerprint).toBe("ml:266.16");
  });

  it("sums masses", () => {
    const flour = (id: string, amount: number) =>
      recipe(id, [line("i1", "flour", { amount, unit: "g", kind: "mass", canon: "flour" })]);
    const got = only(flour("a", 200), flour("b", 300));
    expect(got.amount).toBe("500 g");
    expect(got.fingerprint).toBe("g:500");
  });

  it("sums bare counts, and counts of one unit, ignoring plurals", () => {
    const onion = (id: string, amount: number) =>
      recipe(id, [line("i1", "onion", { amount, canon: "onion" })]);
    expect(only(onion("a", 2), onion("b", 1)).amount).toBe("3");
    expect(only(onion("a", 2), onion("b", 1)).fingerprint).toBe("count:3");
    const garlic = (id: string, amount: number, unit: string) =>
      recipe(id, [line("i1", "garlic", { amount, unit, kind: "count", canon: "garlic" })]);
    const got = only(garlic("a", 2, "cloves"), garlic("b", 1, "clove"));
    expect(got.amount).toBe("3 cloves");
    expect(got.fingerprint).toBe("clove:3");
  });

  it("stays a volume when every line has a trusted density", () => {
    const dense = (id: string, amount: number, unit: string) =>
      recipe(id, [{ ...milk(id, amount, unit), facts: { ...milk(id, amount, unit).facts, conversion: flourDensity } }]);
    const got = only(dense("a", 1, "cup"), dense("b", 2, "tbsp"));
    expect(got.amount).toBe("1⅛ cups");
    expect(got.fingerprint).toBe("ml:266.16");
  });
});

describe("different kinds", () => {
  const cup = line("i1", "1 cup flour", { unit: "cup", kind: "volume", canon: "flour" });
  const grams = line("i1", "200 g flour", { amount: 200, unit: "g", kind: "mass", canon: "flour" });

  it("become an estimated mass when every conversion is trusted", () => {
    const got = only(
      recipe("a", [{ ...cup, facts: { ...cup.facts, conversion: flourDensity } }]),
      recipe("b", [grams]),
    );
    expect(got.amount).toBe("≈ 318 g");
    expect(got.fingerprint).toBe("g:318.29");
  });

  it("scale each line's estimated weight by its entry's factor", () => {
    const a = recipe("a", [{ ...cup, facts: { ...cup.facts, conversion: flourDensity } }]);
    const got = item(list(plan([[["a", 2], ["b", 2]]]), [a, recipe("b", [grams])]), "c:flour");
    expect(got.amount).toBe("≈ 637 g");
    expect(got.fingerprint).toBe("g:636.59");
  });

  const cloves = (count_unit: string) =>
    line("i1", "2 cloves garlic", {
      amount: 2,
      unit: "cloves",
      kind: "count",
      canon: "garlic",
      conv: conversion({ grams_per_count: 5, count_unit }),
    });
  const garlicGrams = line("i1", "10 g garlic", {
    amount: 10,
    unit: "g",
    kind: "mass",
    canon: "garlic",
  });

  it("weigh a count by its trusted weight per count, when its unit fits", () => {
    const got = only(recipe("a", [cloves("clove")]), recipe("b", [garlicGrams]));
    expect(got.amount).toBe("≈ 20 g");
  });

  it("keep a count whose weight is for another unit as its own subtotal", () => {
    const got = only(recipe("a", [cloves("head")]), recipe("b", [garlicGrams]));
    expect(got.amount).toBe("10 g + 2 cloves");
  });

  it("keep a subtotal per kind when a conversion isn't trusted", () => {
    const got = only(
      recipe("a", [{ ...cup, facts: { ...cup.facts, conversion: unchecked } }]),
      recipe("b", [grams]),
    );
    expect(got.amount).toBe("1 cup + 200 g");
    expect(got.fingerprint).toBe("g:200+ml:236.59");
  });

  it("keep a subtotal per count unit without a trusted weight", () => {
    const got = only(
      recipe("a", [
        line("i1", "garlic", { amount: 2, unit: "cloves", kind: "count", canon: "garlic" }),
      ]),
      recipe("b", [
        line("i1", "garlic", { amount: 1, unit: "head", kind: "count", canon: "garlic" }),
      ]),
    );
    expect(got.amount).toBe("2 cloves + 1 head");
  });
});

describe("packages", () => {
  const can = (id: string, comment: string) =>
    recipe(id, [
      line("i1", "1 can tomatoes", { unit: "can", kind: "count", comment, canon: "tomato" }),
    ]);

  it("of the same size add up, the size read from the comment", () => {
    const got = only(can("a", "796 ml"), can("b", "796ml, drained"));
    expect(got.amount).toBe("2 cans (796 ml)");
    expect(got.fingerprint).toBe("can(796 ml):2");
  });

  it("of different sizes are separate subtotals", () => {
    const got = only(can("a", "796 ml"), can("b", "398 ml, drained"));
    expect(got.amount).toBe("1 can (398 ml) + 1 can (796 ml)");
    expect(got.fingerprint).toBe("can(398 ml):1+can(796 ml):1");
  });

  it("read the size from brackets in the unit", () => {
    const pkg = (id: string) =>
      recipe(id, [
        line("i1", "cheese", { unit: "package (8 oz)", kind: "count", canon: "butter" }),
      ]);
    expect(only(pkg("a"), pkg("b")).amount).toBe("2 packages (8 oz)");
  });

  it("show their size in each breakdown row", () => {
    expect(only(can("a", "796 ml")).breakdown.map((row) => row.amount)).toEqual([
      "1 can (796 ml)",
    ]);
  });

  it("are never converted to mass", () => {
    const trusted = conversion({ grams_per_count: 800, count_unit: "can" });
    const sized = line("i1", "can", {
      unit: "can",
      kind: "count",
      comment: "796 ml",
      canon: "tomato",
      conv: trusted,
    });
    const grams = line("i1", "200 g", { amount: 200, unit: "g", kind: "mass", canon: "tomato" });
    expect(only(recipe("a", [sized]), recipe("b", [grams])).amount).toBe("200 g + 1 can (796 ml)");
  });
});

describe("ranges", () => {
  it("sum lows and highs separately", () => {
    const got = only(
      recipe("a", [milk("a", [1, 2], "tbsp")]),
      recipe("b", [milk("b", [1, 3], "tbsp")]),
    );
    expect(got.amount).toBe("2–5 tbsp");
    expect(got.fingerprint).toBe("ml:29.57-73.93");
  });
});

describe("to taste", () => {
  const toTaste = line("i1", "salt to taste", { amount: null, canon: "salt" });

  it("stays in its Store Category with no amount", () => {
    const result = list(plan([[["a"]]]), [recipe("a", [toTaste])]);
    expect(result.categories.map((c) => c.category.name)).toEqual(["Aisles"]);
    const got = item(result, "c:salt");
    expect(got.amount).toBe("to taste");
    expect(got.fingerprint).toBe("");
    expect(got.tick).toBe("c:salt|");
  });

  it("adds nothing to an item with amounts, but shows in its breakdown", () => {
    const tsp = line("i1", "1 tsp salt", { unit: "tsp", kind: "volume", canon: "salt" });
    const got = only(recipe("a", [toTaste]), recipe("b", [tsp]));
    expect(got.amount).toBe("1 tsp");
    expect(got.breakdown.map((row) => row.amount)).toEqual(["to taste", "1 tsp"]);
  });
});

describe("Other", () => {
  const unmatched = line("i2", "a pinch of something", { canon: null });

  it("is a line without a Canonical Ingredient, as written, labelled with its recipe", () => {
    const result = list(plan([[["a"]]]), [recipe("a", [unmatched])]);
    expect(result.categories).toEqual([
      {
        category: { id: null, name: "Other" },
        items: [
          expect.objectContaining({
            key: "o:e1:i2",
            name: "a pinch of something",
            recipe: "Title a",
          }),
        ],
      },
    ]);
  });

  it("holds unparsed lines and lines of an unknown Canonical Ingredient", () => {
    const unparsed = line("i3", "something odd", { unparsed: true, canon: "onion" });
    const unknown = line("i4", "dragonfruit", { canon: "dragonfruit" });
    const result = list(plan([[["a"]]]), [recipe("a", [unparsed, unknown])]);
    expect(items(result).map((i) => i.key)).toEqual(["o:e1:i4", "o:e1:i3"]);
  });

  it("carries its entry's factor when that isn't 1×, as its text isn't scaled", () => {
    const result = list(plan([[["a", 2]], [["a"]]]), [recipe("a", [unmatched])]);
    expect(items(result).map((i) => i.factor)).toEqual([2, undefined]);
  });

  it("unticks when its entry's scale changes, and ticks again when it returns", () => {
    const at = (factor: Factor) =>
      item(list(plan([[["a", factor]]], ["o:e1:i2|"]), [recipe("a", [unmatched])]), "o:e1:i2");
    expect(at(1).ticked).toBe(true);
    expect(at(2)).toMatchObject({ tick: "o:e1:i2|x2", ticked: false, tickedEarlier: "1×" });
    expect(at(0.5).tick).toBe("o:e1:i2|x0.5");
    expect(at(1).ticked).toBe(true);
  });

  it("is one item per entry when a recipe is planned twice", () => {
    const result = list(plan([[["a"]], [["a"]]]), [recipe("a", [unmatched])]);
    expect(items(result).map((i) => i.key)).toEqual(["o:e1:i2", "o:e2:i2"]);
  });
});

describe("recipes that aren't Ready", () => {
  it("are left out and named once each", () => {
    const pending = recipe("p", [milk("p", 1, "cup")], "awaiting_review");
    const ready = recipe("r", [milk("r", 1, "cup")]);
    const week = plan([
      [["p"], ["r"]],
      [["p"], ["gone"]],
    ]);
    const result = list(week, [pending, ready]);
    expect(result.notReady).toEqual([
      { recipe_id: "p", title: "Title p" },
      { recipe_id: "gone", title: "Title gone" },
    ]);
    expect(item(result, "c:milk").amount).toBe("1 cup");
  });
});

describe("entries", () => {
  it("count on every day, twice when planned twice, scaled by their factor", () => {
    const a = recipe("a", [milk("a", 1, "cup")]);
    const result = list(plan([[["a", 2]], [], [], [], [], [], [["a", 0.5]]]), [a]);
    const got = item(result, "c:milk");
    expect(got.amount).toBe("2½ cups");
    expect(got.breakdown).toEqual([
      {
        entry_id: "e1",
        recipe_id: "a",
        title: "Title a",
        day: 0,
        date: "2026-11-23",
        amount: "2 cups",
      },
      {
        entry_id: "e2",
        recipe_id: "a",
        title: "Title a",
        day: 6,
        date: "2026-11-29",
        amount: "½ cup",
      },
    ]);
  });

  it("use Our Version's effective lines", () => {
    const a = recipe("a", [milk("a", 1, "cup")]);
    const ours = {
      ...a,
      our_version: {
        ingredients: {
          remove: [],
          edit: { i1: { text: "3 cups milk", component: null } },
          add: [],
        },
        steps: { remove: [], edit: {}, add: [] },
        facts: { ingredients: { i1: milk("a", 3, "cup").facts }, steps: {} },
      },
    } as unknown as Recipe;
    expect(item(list(plan([[["a"]]]), [ours]), "c:milk").amount).toBe("3 cups");
  });
});

describe("display unit", () => {
  it("is the largest contribution's system", () => {
    expect(
      only(recipe("a", [milk("a", 1, "cup")]), recipe("b", [milk("b", 500, "ml")])).amount,
    ).toBe("737 ml");
    expect(
      only(recipe("a", [milk("a", 1, "cup")]), recipe("b", [milk("b", 100, "ml")])).amount,
    ).toBe("1⅜ cups");
  });

  it("rounds to a friendly unit in that system", () => {
    const tsp = (id: string) => recipe(id, [milk(id, 16, "tsp")]);
    expect(only(tsp("a"), tsp("b"), tsp("c")).amount).toBe("1 cup");
    const kilo = (id: string) =>
      recipe(id, [line("i1", "flour", { amount: 600, unit: "g", kind: "mass", canon: "flour" })]);
    expect(only(kilo("a"), kilo("b")).amount).toBe("1.2 kg");
  });
});

describe("layout", () => {
  it("orders categories as the household does, items alphabetically, Other last", () => {
    const a = recipe("a", [
      milk("a", 1, "cup"),
      line("i2", "onion", { canon: "onion" }),
      line("i3", "garlic", { unit: "clove", kind: "count", canon: "garlic" }),
      line("i4", "zzz unmatched", {}),
      line("i5", "mystery", { canon: "mystery" }),
      line("i6", "aaa unmatched", {}),
    ]);
    const result = list(plan([[["a"]]]), [a]);
    expect(result.categories.map((c) => [c.category.name, c.items.map((i) => i.name)])).toEqual([
      ["Produce", ["garlic", "onion"]],
      ["Dairy", ["milk"]],
      ["Other", ["aaa unmatched", "mystery", "zzz unmatched"]],
    ]);
  });

  it("sinks ticked items to the bottom of their category", () => {
    const a = recipe("a", [
      line("i1", "onion", { canon: "onion" }),
      line("i2", "garlic", { canon: "garlic" }),
      line("i3", "parsley", { canon: "parsley" }),
    ]);
    const result = list(plan([[["a"]]], ["c:garlic|count:1", "c:onion|count:1"]), [a]);
    expect(items(result).map((i) => [i.name, i.ticked])).toEqual([
      ["parsley", false],
      ["garlic", true],
      ["onion", true],
    ]);
  });
});

describe("ticks", () => {
  const onion = (id: string, amount: number) =>
    recipe(id, [line("i1", "onion", { amount, canon: "onion" })]);

  it("go stale when the total grows, showing the amount ticked earlier", () => {
    const result = list(plan([[["a"], ["b"]]], ["c:onion|count:2"]), [
      onion("a", 2),
      onion("b", 1),
    ]);
    const got = item(result, "c:onion");
    expect(got.tick).toBe("c:onion|count:3");
    expect(got.ticked).toBe(false);
    expect(got.tickedEarlier).toBe("2");
  });

  it("match again when the total returns", () => {
    const got = item(
      list(plan([[["a"]]], ["c:onion|count:2", "c:onion|count:3"]), [onion("a", 2)]),
      "c:onion",
    );
    expect(got.ticked).toBe(true);
    expect(got.tickedEarlier).toBeUndefined();
  });

  it("show the largest earlier amount in the item's units", () => {
    const ticks = ["c:milk|ml:236.59", "c:milk|ml:473.18", "c:gone|count:1"];
    const got = item(list(plan([[["a"]]], ticks), [recipe("a", [milk("a", 3, "cup")])]), "c:milk");
    expect(got.tickedEarlier).toBe("2 cups");
  });

  it("show nothing ticked earlier when only other items are ticked", () => {
    const a = recipe("a", [
      line("i1", "onion", { canon: "onion" }),
      line("i2", "garlic", { canon: "garlic" }),
    ]);
    const result = list(plan([[["a"]]], ["c:garlic|count:1", "c:garlic|count:5"]), [a]);
    expect(item(result, "c:onion").ticked).toBe(false);
    expect(item(result, "c:onion").tickedEarlier).toBeUndefined();
  });

  it("read back a count unit with brackets, and a package, from an earlier tick", () => {
    const garlic = line("i1", "garlic", { amount: 3, unit: "clove(s)", kind: "count", canon: "garlic" });
    const result = list(plan([[["a"]]], ["c:garlic|clove(s):2", "c:tomato|can(796 ml):1"]), [
      recipe("a", [
        garlic,
        line("i2", "2 cans tomatoes", { amount: 2, unit: "can", kind: "count", comment: "796 ml", canon: "tomato" }),
      ]),
    ]);
    expect(item(result, "c:garlic").tickedEarlier).toBe("2 clove(s)");
    expect(item(result, "c:tomato").tickedEarlier).toBe("1 can (796 ml)");
  });

  it("keep \"≈\" on an earlier estimated weight", () => {
    const cup = line("i1", "1 cup flour", {
      unit: "cup",
      kind: "volume",
      canon: "flour",
      conv: flourDensity,
    });
    const grams = line("i1", "200 g flour", { amount: 200, unit: "g", kind: "mass", canon: "flour" });
    const result = list(plan([[["a"], ["b"]]], ["c:flour|g:200"]), [
      recipe("a", [cup]),
      recipe("b", [grams]),
    ]);
    expect(item(result, "c:flour").tickedEarlier).toBe("≈ 200 g");
  });
});
