import {
  counted,
  gramsPerUnit,
  inMetric,
  lineView,
  measure,
  type Range,
  SPOONS_AND_CUPS,
  tidy,
  us,
  weighs,
} from "./adjust";
import { formatAmount, formatQuantity } from "./amount";
import type {
  CanonicalIngredient,
  IngredientFacts,
  KitchenSettings,
  ParseFact,
  Recipe,
  WeekPlan,
  WeekPlanEntry,
} from "./api/client";
import { effective } from "./ourVersion";
import { addDays } from "./weekDates";

// One recipe entry's part of a Grocery Item: its day and that entry's own scaled amount.
export type BreakdownRow = {
  entry_id: string;
  recipe_id: string;
  title: string;
  day: number;
  date: string;
  amount: string;
};

// One row of the Grocery List. `amount` is the summed amount for display ("2 cups + 300 g",
// "≈ 450 g", "to taste"), null for an Other line, which shows only its text (`name`) and its
// recipe. `tick` is what `grocery_ticks` holds when it's ticked at this amount; `tickedEarlier`
// is the amount an older tick of the same item was made at, when only that one matches.
export type GroceryItem = {
  key: string;
  name: string;
  recipe?: string;
  amount: string | null;
  fingerprint: string;
  tick: string;
  ticked: boolean;
  tickedEarlier?: string;
  breakdown: BreakdownRow[];
};

// A Store Category with its items, or Other (id null).
export type GroceryCategory = {
  category: { id: string | null; name: string };
  items: GroceryItem[];
};
export type GroceryList = {
  categories: GroceryCategory[];
  notReady: { recipe_id: string; title: string }[];
};

type Kind = "volume" | "mass" | "count" | "package";
// One line's amount, or a sum of them: in ml, g, or a count of `unit` (bare when null), with the
// size of a package. `metric` and `largest` follow the largest contribution, which picks the
// unit system an amount shows in. `estimated` marks a weight from a conversion.
type Amount = {
  key: string;
  kind: Kind;
  low: number;
  high: number;
  unit: string | null;
  size?: string;
  metric: boolean;
  largest: number;
  estimated: boolean;
};

const KIND_ORDER: Kind[] = ["volume", "mass", "count", "package"];
const OTHER = { id: null, name: "Other" };

// A package size, "796 ml" or "8 oz", at the start of `text`, in a known unit, written one way.
function sizeOf(text: string | null): string | undefined {
  const found = text?.trim().match(/^(\d+(?:\.\d+)?)\s*([a-z]+(?: oz)?)\b/i);
  if (!found?.[1] || !found[2] || !measure(found[2])) return undefined;
  return `${Number(found[1])} ${found[2].toLowerCase()}`;
}

// A sized count is a package: its size in brackets in the unit ("package (8 oz)"), or leading
// the comment, where the parser puts "1 can (796 ml)"'s.
function packageOf(parse: ParseFact): { unit: string; size: string } | undefined {
  if (!parse.unit || measure(parse.unit)) return undefined;
  const bracket = parse.unit.match(/^(.*\S)\s*\(([^)]*)\)$/);
  const inUnit = bracket?.[1] && sizeOf(bracket[2] ?? null);
  if (inUnit) return { unit: counted(bracket[1] as string, 1) as string, size: inUnit };
  const inComment = sizeOf(parse.comment);
  return inComment ? { unit: counted(parse.unit, 1) as string, size: inComment } : undefined;
}

// A line's amount × `factor`, or undefined for "to taste".
function amountOf(facts: IngredientFacts, factor: number): Amount | undefined {
  const parse = facts.parse as ParseFact;
  if (!parse.quantity) return undefined;
  const low = parse.quantity.low * factor;
  const high = parse.quantity.high * factor;
  const base = { low, high, unit: null, metric: true, largest: high, estimated: false };
  const m = measure(parse.unit);
  if (m) {
    const [l, h] = [low * m.base, high * m.base];
    const key = m.kind === "mass" ? "g" : "ml";
    return { ...base, key, kind: m.kind, low: l, high: h, metric: m.metric, largest: h };
  }
  const pkg = packageOf(parse);
  if (pkg) return { ...base, key: `${pkg.unit}(${pkg.size})`, kind: "package", ...pkg };
  const unit = parse.unit ? (counted(parse.unit, 1) as string).toLowerCase() : null;
  return { ...base, key: unit ?? "count", kind: "count", unit };
}

// The same amount as an estimated weight from its trusted conversion.
function asMass(amount: Amount, facts: IngredientFacts, factor: number): Amount {
  if (amount.kind === "mass") return amount;
  const { low, high } = (facts.parse as ParseFact).quantity as { low: number; high: number };
  const per = (gramsPerUnit(facts) as number) * factor;
  return {
    ...amount,
    key: "g",
    kind: "mass",
    unit: null,
    low: low * per,
    high: high * per,
    largest: high * per,
    estimated: true,
  };
}

// One Canonical Ingredient's lines summed: same kind exactly; different kinds as mass when every
// line is a weight or has a trusted conversion, else one subtotal per kind and unit. Packages
// stay packages, and "to taste" lines add nothing.
function sum(lines: { facts: IngredientFacts; factor: number }[]): Amount[] {
  const amounts = lines.flatMap(({ facts, factor }) => {
    const amount = amountOf(facts, factor);
    return amount ? [{ amount, facts, factor }] : [];
  });
  const loose = amounts.filter(({ amount }) => amount.kind !== "package");
  const toMass =
    new Set(loose.map(({ amount }) => amount.key)).size > 1 &&
    loose.every(({ amount, facts }) => amount.kind === "mass" || weighs(facts));
  const sums = new Map<string, Amount>();
  for (const { amount, facts, factor } of amounts) {
    const add = toMass && amount.kind !== "package" ? asMass(amount, facts, factor) : amount;
    const held = sums.get(add.key);
    if (!held) {
      sums.set(add.key, add);
      continue;
    }
    const bigger = add.largest > held.largest;
    sums.set(add.key, {
      ...held,
      low: held.low + add.low,
      high: held.high + add.high,
      metric: bigger ? add.metric : held.metric,
      largest: Math.max(held.largest, add.largest),
      estimated: held.estimated || add.estimated,
    });
  }
  return [...sums.values()].sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.key.localeCompare(b.key),
  );
}

// An amount for display, in its system's friendly unit; a weight from a conversion takes "≈".
function show(a: Amount): string {
  const range: Range = [a.low, a.high];
  if (a.kind === "volume")
    return a.metric ? inMetric(range, "volume", true) : tidy(range, SPOONS_AND_CUPS);
  if (a.kind === "mass") {
    const text = a.metric ? inMetric(range, "mass", !a.estimated) : us(range);
    return a.estimated && !text.startsWith("under") ? `≈ ${text}` : text;
  }
  const quantity = { low: a.low, high: a.high };
  if (a.kind === "package")
    return `${formatQuantity(quantity)} ${counted(a.unit, a.high)} (${a.size})`;
  return formatAmount(quantity, counted(a.unit, a.high));
}

// The amounts in canonical form, sorted, to two places: "g:300+ml:473.18", "ml:15-30".
const round = (value: number) => String(Math.round(value * 100) / 100);
function fingerprintOf(amounts: Amount[]): string {
  return amounts
    .map(({ key, low, high }) => {
      const [l, h] = [round(low), round(high)];
      return `${key}:${l === h ? l : `${l}-${h}`}`;
    })
    .sort()
    .join("+");
}

// A fingerprint read back into amounts, in the systems the item shows its own amounts in.
function amountsOf(fingerprint: string, current: Amount[]): Amount[] {
  if (!fingerprint) return [];
  return fingerprint.split("+").map((part) => {
    const at = part.lastIndexOf(":");
    const key = part.slice(0, at);
    const [low = 0, high = low] = part
      .slice(at + 1)
      .split("-")
      .map(Number);
    const pkg = key.match(/^(.*)\((.*)\)$/);
    const kind: Kind = key === "g" ? "mass" : key === "ml" ? "volume" : pkg ? "package" : "count";
    const unit = pkg ? (pkg[1] ?? null) : kind === "count" && key !== "count" ? key : null;
    const metric = current.find((a) => a.kind === kind)?.metric ?? true;
    const size = pkg?.[2];
    return { key, kind, low, high, unit, metric, largest: high, estimated: false, size };
  });
}

const toTasteText = (amounts: Amount[]) =>
  amounts.length ? amounts.map(show).join(" + ") : "to taste";

// Whether the item is ticked at its amount, else the amount of an older tick of it: of several,
// the largest, by the sum of their high ends, then by text.
function ticks(key: string, fingerprint: string, current: Amount[], set: Set<string>) {
  const tick = `${key}|${fingerprint}`;
  if (set.has(tick)) return { tick, ticked: true };
  const earlier = [...set]
    .filter((t) => t.startsWith(`${key}|`))
    .map((t) => amountsOf(t.slice(key.length + 1), current))
    .map((amounts) => ({ amounts, size: amounts.reduce((n, a) => n + a.high, 0) }))
    .sort(
      (a, b) => b.size - a.size || fingerprintOf(a.amounts).localeCompare(fingerprintOf(b.amounts)),
    )[0];
  if (!earlier) return { tick, ticked: false };
  return { tick, ticked: false, tickedEarlier: toTasteText(earlier.amounts) };
}

type Contribution = { entry: WeekPlanEntry; day: number; facts: IngredientFacts };

// The Week Plan's Grocery List: every entry of a Ready recipe, its effective lines × the entry's
// factor, one Grocery Item per Canonical Ingredient in its Store Category, and each line without
// one under Other. Recipes not Ready (or not loaded) are named in `notReady` instead.
export function groceryList(
  plan: WeekPlan,
  recipes: Map<string, Recipe | undefined>,
  canonicalIngredients: CanonicalIngredient[],
  settings: KitchenSettings,
): GroceryList {
  const canonicalById = new Map(canonicalIngredients.map((c) => [c.id, c]));
  const categoryIds = new Set(settings.store_categories.map((c) => c.id));
  const tickSet = new Set(plan.grocery_ticks);
  const notReady = new Map<string, string>();
  const byCanonical = new Map<string, Contribution[]>();
  const byCategory = new Map<string | null, GroceryItem[]>();
  const place = (categoryId: string | null, item: GroceryItem) =>
    byCategory.set(categoryId, [...(byCategory.get(categoryId) ?? []), item]);
  const row = (entry: WeekPlanEntry, day: number, amount: string): BreakdownRow => ({
    entry_id: entry.entry_id,
    recipe_id: entry.recipe_id,
    title: entry.recipe_title,
    day,
    date: addDays(plan.week_start, day),
    amount,
  });

  plan.days.forEach((entries, day) => {
    for (const entry of entries) {
      const recipe = recipes.get(entry.recipe_id);
      if (recipe?.status !== "ready") {
        if (!notReady.has(entry.recipe_id)) notReady.set(entry.recipe_id, entry.recipe_title);
        continue;
      }
      const { original, facts } = effective(recipe, "ours");
      for (const line of original.ingredients) {
        const lineFacts = facts.ingredients[line.id];
        const canonicalId = lineFacts?.match?.canonical_id;
        if (!lineFacts?.parse || !canonicalId || !canonicalById.has(canonicalId)) {
          const key = `o:${entry.entry_id}:${line.id}`;
          place(null, {
            key,
            name: line.text,
            recipe: entry.recipe_title,
            amount: null,
            fingerprint: "",
            ...ticks(key, "", [], tickSet),
            breakdown: [row(entry, day, line.text)],
          });
          continue;
        }
        const held = byCanonical.get(canonicalId) ?? [];
        byCanonical.set(canonicalId, [...held, { entry, day, facts: lineFacts }]);
      }
    }
  });

  for (const [canonicalId, contributions] of byCanonical) {
    const canonical = canonicalById.get(canonicalId) as CanonicalIngredient;
    const amounts = sum(
      contributions.map(({ entry, facts }) => ({ facts, factor: entry.amount.factor })),
    );
    const key = `c:${canonicalId}`;
    const fingerprint = fingerprintOf(amounts);
    // One row per entry: each of its lines' amounts as that recipe shows them at its factor.
    const rows = new Map<string, BreakdownRow>();
    for (const { entry, day, facts } of contributions) {
      const amount = amountOf(facts, entry.amount.factor);
      const own = !amount
        ? "to taste"
        : lineView(facts, { scale: entry.amount.factor, units: "written" }).amount +
          (amount.kind === "package" && !facts.parse?.unit?.includes("(")
            ? ` (${amount.size})`
            : "");
      const held = rows.get(entry.entry_id);
      rows.set(
        entry.entry_id,
        held ? { ...held, amount: `${held.amount} + ${own}` } : row(entry, day, own),
      );
    }
    const categoryId = categoryIds.has(canonical.store_category_id)
      ? canonical.store_category_id
      : null;
    place(categoryId, {
      key,
      name: canonical.name,
      amount: toTasteText(amounts),
      fingerprint,
      ...ticks(key, fingerprint, amounts, tickSet),
      breakdown: [...rows.values()],
    });
  }

  const categories = [...settings.store_categories, OTHER].flatMap((category) => {
    const items = byCategory.get(category.id);
    if (!items) return [];
    items.sort((a, b) => Number(a.ticked) - Number(b.ticked) || a.name.localeCompare(b.name));
    return [{ category: { id: category.id, name: category.name }, items }];
  });
  return {
    categories,
    notReady: [...notReady].map(([recipe_id, title]) => ({ recipe_id, title })),
  };
}
