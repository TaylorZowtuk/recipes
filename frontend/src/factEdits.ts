import type { DifficultyChoice } from "./addRecipe";
import { FRACTIONS, kitchenNumber } from "./amount";
import type { Collection, Recipe } from "./api/client";
import type { FactEdit } from "./review";

// What an editor's edit form holds for each kind of Review Item, as typed, and the edit it saves:
// or, when what's typed can't be saved, why not.

// A problem may name the field at fault, by its label or the name a form gives it.
export type Built = { edit: FactEdit } | { problem: string; field?: string };

// A line's name as parsed, else as written.
export function lineName(recipe: Recipe, lineId: string) {
  return (
    recipe.facts.ingredients[lineId]?.parse?.name ??
    recipe.original.ingredients.find((line) => line.id === lineId)?.text ??
    lineId
  );
}

const GLYPHS = new Map(FRACTIONS.map(([part, glyph]) => [glyph, part]));

// A number as an editor types it: "2", "1.5", "1/2", "1 1/2", or a kitchen fraction as the recipe
// shows it, "½", "1 ½" or "1½". Undefined if it isn't one.
export function readNumber(text: string): number | undefined {
  const typed = /^(?:(\d*\.?\d+)|(?:(\d+)\s+)?(\d+)\/(\d+)|(?:(\d+)\s*)?(.))$/u.exec(text.trim());
  if (!typed) return undefined;
  const [, decimal, whole, top, bottom, glyphWhole, glyph] = typed;
  if (decimal !== undefined) return Number(decimal);
  if (glyph !== undefined) {
    const part = GLYPHS.get(glyph);
    return part === undefined ? undefined : Number(glyphWhole ?? 0) + part;
  }
  return Number(bottom) ? Number(whole ?? 0) + Number(top) / Number(bottom) : undefined;
}

// A number field read back: the stored number while the text is still that number as the form
// showed it, since showing it may have rounded it, so saving never changes a number nobody touched.
function readField(text: string, stored: number | undefined): number | undefined {
  return stored !== undefined && text.trim() === kitchenNumber(stored) ? stored : readNumber(text);
}

// A timer's end in seconds, from its minutes as typed, or as stored while untouched.
function readSeconds(text: string, stored: number | undefined): number {
  if (stored !== undefined && text.trim() === kitchenNumber(stored / 60)) return stored;
  return Math.round((readNumber(text) ?? Number.NaN) * 60);
}

// The Wording Cache's key for an ingredient's name, as the API's `normalize_wording` makes it:
// lowercase, its whitespace collapsed and the ASCII punctuation around it stripped.
export function normalizeWording(name: string): string {
  return name
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
    .replace(/^[\s!-/:-@[-`{-~]+|[\s!-/:-@[-`{-~]+$/g, "");
}

// Keep the line's Canonical Ingredient, choose another, or create one.
export type CanonicalPick =
  | { kind: "keep" }
  | { kind: "existing"; id: string }
  | { kind: "new"; name: string; family: string; storeCategoryId: string };

export type LineDraft = {
  low: string;
  high: string;
  // The amount as stored, which `low` and `high` show.
  stored: { low: number; high: number } | null;
  unit: string;
  name: string;
  preparation: string;
  canonical: CanonicalPick;
  // Whether the line stays in its written unit, or null when it has no weight to keep or convert.
  keepWeight: boolean | null;
  // The FDC food and portion chosen for the Canonical Ingredient pick that `foodFor` names. Once
  // the pick changes, the food is that pick's default again.
  food: FoodPick;
  foodFor: string;
};

// An FDC food and its portion, or none chosen yet. No portion means no weight.
export type FoodPick = { fdcId: number; portionId: number | null } | null;

export function lineDraft(recipe: Recipe, lineId: string): LineDraft {
  const { parse, match, conversion } = recipe.facts.ingredients[lineId] ?? {};
  const quantity = parse?.quantity;
  return {
    low: quantity ? kitchenNumber(quantity.low) : "",
    high: quantity && quantity.high !== quantity.low ? kitchenNumber(quantity.high) : "",
    stored: quantity ?? null,
    unit: parse?.unit ?? "",
    name: lineName(recipe, lineId),
    preparation: parse?.preparation ?? "",
    canonical: { kind: "keep" },
    keepWeight: conversion ? !!conversion.refused : null,
    food: match ? { fdcId: match.fdc_id, portionId: match.portion_id } : null,
    foodFor: KEEP,
  };
}

const KEEP = "keep";

// The Canonical Ingredient a pick leaves the line with, which the food's default follows. Choosing
// the line's own again keeps it.
export function pickKey(recipe: Recipe, lineId: string, pick: CanonicalPick): string {
  const current = recipe.facts.ingredients[lineId]?.match?.canonical_id;
  if (pick.kind === "keep" || (pick.kind === "existing" && pick.id === current)) return KEEP;
  return pick.kind === "existing" ? pick.id : "new";
}

// The food a pick starts with: the line's own while it keeps its Canonical Ingredient, else the
// food of a line already matched to the chosen one, a Confirmed one first, with no portion, since
// that line's portion may not fit this one's unit. The PWA holds only this recipe's facts, so only
// its lines can give one. A new Canonical Ingredient starts with none.
export function defaultFood(recipe: Recipe, lineId: string, pick: CanonicalPick): FoodPick {
  const key = pickKey(recipe, lineId, pick);
  if (key === KEEP) return lineDraft(recipe, lineId).food;
  const matched = Object.values(recipe.facts.ingredients).flatMap((line) =>
    line.match?.canonical_id === key ? [line.match] : [],
  );
  const donor = matched.find((match) => match.confirmed) ?? matched[0];
  return donor ? { fdcId: donor.fdc_id, portionId: null } : null;
}

// The food as the draft saves it: the one chosen for its pick, else the pick's default.
export function foodOf(recipe: Recipe, lineId: string, draft: LineDraft): FoodPick {
  return draft.foodFor === pickKey(recipe, lineId, draft.canonical)
    ? draft.food
    : defaultFood(recipe, lineId, draft.canonical);
}

// What the FDC food search starts with for a pick: its Canonical Ingredient's name, else the
// line's name.
export function foodQuery(
  recipe: Recipe,
  lineId: string,
  pick: CanonicalPick,
  collection: Pick<Collection, "canonical_ingredients">,
): string {
  if (pick.kind === "new") return pick.name;
  const id =
    pick.kind === "existing" ? pick.id : recipe.facts.ingredients[lineId]?.match?.canonical_id;
  return (
    collection.canonical_ingredients.find((c) => c.id === id)?.name ?? lineName(recipe, lineId)
  );
}

// Whether the line's FDC food gives anything to convert it to a weight by.
export function canConvert(recipe: Recipe, lineId: string) {
  const conversion = recipe.facts.ingredients[lineId]?.conversion;
  return conversion?.density_g_per_ml != null || conversion?.grams_per_count != null;
}

const AMOUNT = "Give the amount as a number, such as 2, 1.5 or 1 1/2, or leave it empty.";
// The food search's label, which a missing food's problem names.
export const FOOD_SEARCH = "Find an FDC food";
const NO_FOOD = "Choose an FDC food for this line: the closest one if none fits.";

export function lineEdit(recipe: Recipe, lineId: string, draft: LineDraft): Built {
  const low = draft.low.trim() ? readField(draft.low, draft.stored?.low) : null;
  const high = draft.high.trim() ? readField(draft.high, draft.stored?.high) : low;
  if (low === undefined || (low === null && high !== null))
    return { problem: AMOUNT, field: "Amount" };
  if (high === undefined) return { problem: AMOUNT, field: "Up to" };
  if (low !== null && high !== null && high < low)
    return { problem: "The amount’s upper end can’t be below its lower end.", field: "Up to" };
  const name = draft.name.trim();
  if (!name) return { problem: "Give the ingredient a name.", field: "Name" };
  const pick = draft.canonical;
  let canonical: Extract<FactEdit, { kind: "line" }>["canonical"];
  if (pick.kind === "existing") canonical = { kind: "existing", id: pick.id };
  if (pick.kind === "new") {
    const family = pick.family.trim().toLowerCase();
    if (!pick.name.trim())
      return { problem: "Give the new Canonical Ingredient a name.", field: "New name" };
    if (!family || !pick.storeCategoryId)
      return {
        problem: "Give the new Canonical Ingredient a family and a Store Category.",
        ...(!family && { field: "Family" }),
      };
    canonical = {
      kind: "new",
      name: pick.name.trim(),
      family,
      store_category_id: pick.storeCategoryId,
    };
  }
  const food = foodOf(recipe, lineId, draft);
  if (!food) return { problem: NO_FOOD, field: FOOD_SEARCH };
  const edit: FactEdit = {
    kind: "line",
    line_id: lineId,
    quantity: low !== null && high !== null ? { low, high } : null,
    unit: draft.unit.trim() || null,
    name,
    preparation: draft.preparation.trim() || null,
    fdc_id: food.fdcId,
    portion_id: food.portionId,
    ...(canonical && { canonical }),
  };
  // A new Canonical Ingredient brings its own weight, if any, so the choice is only for the kept one.
  const was = lineDraft(recipe, lineId).keepWeight;
  if (pick.kind === "keep" && draft.keepWeight !== null && draft.keepWeight !== was)
    edit.keep_weight = draft.keepWeight;
  return { edit };
}

type Wordings = Pick<Collection, "canonical_ingredients" | "wordings">;

// Whether the name's wording isn't the matched line's: then keeping the line's Canonical Ingredient
// would confirm it for the new wording, so the API wants a choice.
export function renamed(recipe: Recipe, lineId: string, name: string): boolean {
  const { parse, match } = recipe.facts.ingredients[lineId] ?? {};
  return !!parse && !!match && normalizeWording(name) !== normalizeWording(parse.name);
}

// The draft as it saves: once its name's wording changed, Keep stands for a choice, the new
// wording's confirmed Wording Cache entry if there is one, else the line's Canonical Ingredient.
// Named back, it keeps it again.
export function withWording(
  recipe: Recipe,
  lineId: string,
  draft: LineDraft,
  collection: Wordings,
): LineDraft {
  const current = recipe.facts.ingredients[lineId]?.match?.canonical_id;
  if (draft.canonical.kind !== "keep" || !current || !renamed(recipe, lineId, draft.name))
    return draft;
  const wording = normalizeWording(draft.name);
  const cached = collection.wordings.find(
    (w) =>
      w.confirmed &&
      w.wording === wording &&
      collection.canonical_ingredients.some((c) => c.id === w.canonical_id),
  );
  return { ...draft, canonical: { kind: "existing", id: cached?.canonical_id ?? current } };
}

// What changing the line's Canonical Ingredient does beyond this line, or null when it's kept. It
// quotes nothing typed, so a live region showing it speaks only when the pick changes.
export function canonicalNote(
  draft: LineDraft,
  collection: Pick<Collection, "canonical_ingredients">,
): string | null {
  const pick = draft.canonical;
  if (pick.kind === "keep") return null;
  const reach = "Every line worded like this one, in every recipe, will use";
  if (pick.kind === "new") return `${reach} the new Canonical Ingredient.`;
  const chosen = collection.canonical_ingredients.find((c) => c.id === pick.id)?.name ?? "it";
  return `${reach} ${chosen}.`;
}

// A step's Step Portions, one for each ingredient segment in order, or for each line it uses when
// it has no segments, and its timers, one for each duration segment.
export function stepRows(recipe: Recipe, stepId: string) {
  const { segments, uses } = recipe.facts.steps[stepId] ?? {};
  if (segments)
    return {
      portions: segments.segments.flatMap((segment) =>
        segment.t === "ingredient"
          ? [{ ref: segment.ref, written: segment.written, portion: segment.portion }]
          : [],
      ),
      timers: segments.segments.flatMap((segment) =>
        segment.t === "duration"
          ? [{ written: segment.written, low_s: segment.low_s, high_s: segment.high_s }]
          : [],
      ),
    };
  return {
    portions: (uses?.uses ?? []).map((use) => ({
      ref: use.ref,
      written: null,
      portion: use.portion,
    })),
    timers: [],
  };
}

// A timer's range in minutes, as typed, and the portions and timers as stored, which they show.
export type StepDraft = {
  portions: string[];
  timers: { low: string; high: string }[];
  stored: { portions: number[]; timers: { low_s: number; high_s: number }[] };
};

export function stepDraft(recipe: Recipe, stepId: string): StepDraft {
  const rows = stepRows(recipe, stepId);
  return {
    portions: rows.portions.map((row) => kitchenNumber(row.portion)),
    timers: rows.timers.map((timer) => ({
      low: kitchenNumber(timer.low_s / 60),
      high: kitchenNumber(timer.high_s / 60),
    })),
    stored: {
      portions: rows.portions.map((row) => row.portion),
      timers: rows.timers.map(({ low_s, high_s }) => ({ low_s, high_s })),
    },
  };
}

export function stepEdit(stepId: string, draft: StepDraft): Built {
  const { stored } = draft;
  const portions = draft.portions.map((text, n) => readField(text, stored.portions[n]));
  const portion = portions.findIndex((p) => p === undefined || p <= 0 || p > 1);
  if (portion >= 0)
    return {
      problem: "Give each portion as a number above 0 and at most 1, such as 1/2.",
      field: `portion-${portion}`,
    };
  const durations = draft.timers.map(({ low, high }, n) => ({
    low_s: readSeconds(low, stored.timers[n]?.low_s),
    high_s: readSeconds(high, stored.timers[n]?.high_s),
  }));
  const timer = durations.findIndex(({ low_s, high_s }) => !(low_s > 0) || !(high_s >= low_s));
  if (timer >= 0)
    return {
      problem: "Give each timer in minutes above 0, its upper end not below its lower end.",
      field: `timer-${timer}`,
    };
  return { edit: { kind: "step", step_id: stepId, portions: portions as number[], durations } };
}

export function substitutionEdit(
  lineId: string,
  index: number,
  ratio: string,
  note: string,
): Built {
  const value = readNumber(ratio);
  if (value === undefined || value <= 0 || value > 10)
    return { problem: "Give the ratio as a number above 0 and at most 10.", field: "Ratio" };
  return {
    edit: { kind: "substitution", line_id: lineId, index, ratio: value, note: note.trim() },
  };
}

export function difficultyEdit({ prep, cook, cleanup }: DifficultyChoice): Built {
  if (!prep || !cook || !cleanup) return { problem: "Rate all of Prep, Cook and Cleanup." };
  return { edit: { kind: "difficulty", prep, cook, cleanup } };
}
