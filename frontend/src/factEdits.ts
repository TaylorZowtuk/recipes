import type { DifficultyChoice } from "./addRecipe";
import { FRACTIONS, kitchenNumber } from "./amount";
import type {
  Collection,
  FdcPortion,
  IngredientFacts,
  Recipe,
  SubstituteDraft,
} from "./api/client";
import type { FactEdit } from "./review";

// What an editor's edit form holds for each kind of Review Item, as typed, and the edit it saves:
// or, when what's typed can't be saved, why not.

// A problem may name the field at fault, by its label or the name a form gives it.
export type Built<E = FactEdit> = { edit: E } | { problem: string; field?: string };

// A line as its edit form reads it: its id, its text as written and its facts, if it has any. An
// Our Version line has its own facts, and a line Our Version is adding has none yet.
export type LineOf = { id: string; text: string; facts?: IngredientFacts | undefined };

export function lineOf(recipe: Pick<Recipe, "original" | "facts">, lineId: string): LineOf {
  return {
    id: lineId,
    text: recipe.original.ingredients.find((line) => line.id === lineId)?.text ?? lineId,
    facts: recipe.facts.ingredients[lineId],
  };
}

// A line's name as parsed, else as written.
const nameOf = (line: LineOf) => line.facts?.parse?.name ?? line.text;

export function lineName(recipe: Pick<Recipe, "original" | "facts">, lineId: string) {
  return nameOf(lineOf(recipe, lineId));
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
  // It starts kept only when its conversion could convert but doesn't.
  keepWeight: boolean | null;
  // The FDC food and portion chosen for the Canonical Ingredient pick that `foodFor` names. Once
  // the pick changes, the food is that pick's default again.
  food: FoodPick;
  foodFor: string;
};

// An FDC food and its portion, or none chosen yet, and whether the portion gives anything to
// convert the line to a weight by. No portion means no weight.
export type FoodPick = { fdcId: number; portionId: number | null; converts: boolean } | null;

// Why a line an editor kept in its written unit doesn't convert, as the API stores it.
export const EDITOR_KEPT = "kept in the written unit by an editor";

export function lineDraft(line: LineOf): LineDraft {
  const { parse, match, conversion } = line.facts ?? {};
  const quantity = parse?.quantity;
  return {
    low: quantity ? kitchenNumber(quantity.low) : "",
    high: quantity && quantity.high !== quantity.low ? kitchenNumber(quantity.high) : "",
    stored: quantity ?? null,
    unit: parse?.unit ?? "",
    name: nameOf(line),
    preparation: parse?.preparation ?? "",
    canonical: { kind: "keep" },
    keepWeight: conversion ? !!conversion.refused && canConvert(line) : null,
    food: match
      ? { fdcId: match.fdc_id, portionId: match.portion_id, converts: canConvert(line) }
      : null,
    foodFor: KEEP,
  };
}

const KEEP = "keep";

// The Canonical Ingredient a pick leaves the line with, which the food's default follows. Choosing
// the line's own again keeps it.
export function pickKey(line: LineOf, pick: CanonicalPick): string {
  const current = line.facts?.match?.canonical_id;
  if (pick.kind === "keep" || (pick.kind === "existing" && pick.id === current)) return KEEP;
  return pick.kind === "existing" ? pick.id : "new";
}

// The food a pick starts with: the line's own while it keeps its Canonical Ingredient, else none
// until the food search answers with the Collection's food for it (see `defaultFrom`).
export function defaultFood(line: LineOf, pick: CanonicalPick): FoodPick {
  return pickKey(line, pick) === KEEP ? lineDraft(line).food : null;
}

// The Canonical Ingredient whose food the search should give as the pick's default: another
// existing one. The PWA holds only this recipe's facts, so the API finds a line in the whole
// Collection matched to it, a Confirmed one first. A new one has no such line.
export function defaultFrom(line: LineOf, pick: CanonicalPick): string | undefined {
  const key = pickKey(line, pick);
  return pick.kind === "existing" && key !== KEEP ? key : undefined;
}

// Whether the line needs an FDC food: only a line that has or gets a Canonical Ingredient has a
// match, and so a food.
export function needsFood(line: LineOf, pick: CanonicalPick): boolean {
  return pick.kind !== "keep" || !!line.facts?.match;
}

// Whether the draft offers keeping the line in its written unit or converting it to a weight: for
// a line that keeps its Canonical Ingredient and has a weight, while its food's portion gives
// something to convert by.
export function canChooseWeight(line: LineOf, draft: LineDraft): boolean {
  return (
    draft.canonical.kind === "keep" && draft.keepWeight !== null && !!foodOf(line, draft)?.converts
  );
}

// Why the chosen portion gives the line, or its substitute, no weight, when the API's search said
// it doesn't fit the line's unit (`unit`, as the search sent it). A substitute stands in for the
// line's amount in that unit. Null when it fits, and when the search didn't say.
export function portionMisfit(
  unit: string | null,
  portion: Pick<FdcPortion, "density_g_per_ml" | "grams_per_count" | "count_unit" | "fits">,
  of: "line" | "substitute" = "line",
): string | null {
  if (portion.fits !== false) return null;
  const is =
    portion.density_g_per_ml !== null
      ? "a volume"
      : portion.grams_per_count !== null
        ? `counted in ${portion.count_unit}`
        : "neither a volume nor a count";
  const line = unit ? `in ${unit}` : "a count with no unit";
  return `This portion is ${is}, but the line is ${line}, so the ${of} gets no weight.`;
}

// The food as the draft saves it: the one chosen for its pick, else the pick's default.
export function foodOf(line: LineOf, draft: LineDraft): FoodPick {
  return draft.foodFor === pickKey(line, draft.canonical)
    ? draft.food
    : defaultFood(line, draft.canonical);
}

// What the FDC food search starts with for a pick: its Canonical Ingredient's name, else the
// line's name.
export function foodQuery(
  line: LineOf,
  pick: CanonicalPick,
  collection: Pick<Collection, "canonical_ingredients">,
): string {
  if (pick.kind === "new") return pick.name;
  const id = pick.kind === "existing" ? pick.id : line.facts?.match?.canonical_id;
  return collection.canonical_ingredients.find((c) => c.id === id)?.name ?? nameOf(line);
}

// Whether the line's stored FDC food and portion give anything to convert it to a weight by.
function canConvert(line: LineOf) {
  const conversion = line.facts?.conversion;
  return conversion?.density_g_per_ml != null || conversion?.grams_per_count != null;
}

const AMOUNT = "Give the amount as a number, such as 2, 1.5 or 1 1/2, or leave it empty.";
// The food search's label, which a missing food's problem names.
export const FOOD_SEARCH = "Find an FDC food";
const NO_FOOD = "Choose an FDC food for this line: the closest one if none fits.";

type CanonicalChoice = NonNullable<LineEdit["canonical"]>;

// The Canonical Ingredient a pick saves: none to keep the one there is, else the one chosen, or a
// new one with its name, its family in lowercase and its Store Category.
function canonicalChoice(pick: CanonicalPick): Built<CanonicalChoice | undefined> {
  if (pick.kind === "keep") return { edit: undefined };
  if (pick.kind === "existing") return { edit: { kind: "existing", id: pick.id } };
  const family = pick.family.trim().toLowerCase();
  if (!pick.name.trim())
    return { problem: "Give the new Canonical Ingredient a name.", field: "New name" };
  if (!family || !pick.storeCategoryId)
    return {
      problem: "Give the new Canonical Ingredient a family and a Store Category.",
      ...(!family && { field: "Family" }),
    };
  return {
    edit: { kind: "new", name: pick.name.trim(), family, store_category_id: pick.storeCategoryId },
  };
}

// A Review line edit, which an Our Version line saves the fields of.
export type LineEdit = Extract<FactEdit, { kind: "line" }>;

export function lineEdit(line: LineOf, draft: LineDraft): Built<LineEdit> {
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
  const chosen = canonicalChoice(pick);
  if ("problem" in chosen) return chosen;
  const canonical = chosen.edit;
  // A line with no Canonical Ingredient has no match, and so no food.
  const food = needsFood(line, pick) ? foodOf(line, draft) : null;
  if (!food && needsFood(line, pick)) return { problem: NO_FOOD, field: FOOD_SEARCH };
  const edit: LineEdit = {
    kind: "line",
    line_id: line.id,
    quantity: low !== null && high !== null ? { low, high } : null,
    unit: draft.unit.trim() || null,
    name,
    preparation: draft.preparation.trim() || null,
    fdc_id: food?.fdcId ?? null,
    portion_id: food?.portionId ?? null,
    ...(canonical && { canonical }),
  };
  // The weight choice goes with a new food or portion, which would otherwise convert, or when it
  // changed. A new Canonical Ingredient's food converts, so the choice is only for the kept one.
  const was = lineDraft(line);
  const newFood = food?.fdcId !== was.food?.fdcId || food?.portionId !== was.food?.portionId;
  if (
    canChooseWeight(line, draft) &&
    draft.keepWeight !== null &&
    (newFood || draft.keepWeight !== was.keepWeight)
  )
    edit.keep_weight = draft.keepWeight;
  return { edit };
}

type Wordings = Pick<Collection, "canonical_ingredients" | "wordings">;

// Whether the name's wording isn't the matched line's: then keeping the line's Canonical Ingredient
// would confirm it for the new wording, so the API wants a choice.
export function renamed(line: LineOf, name: string): boolean {
  const { parse, match } = line.facts ?? {};
  return !!parse && !!match && normalizeWording(name) !== normalizeWording(parse.name);
}

// The draft as it saves: once its name's wording changed, Keep stands for a choice, the new
// wording's confirmed Wording Cache entry if there is one, else the line's Canonical Ingredient.
// Named back, it keeps it again.
export function withWording(line: LineOf, draft: LineDraft, collection: Wordings): LineDraft {
  const current = line.facts?.match?.canonical_id;
  if (draft.canonical.kind !== "keep" || !current || !renamed(line, draft.name)) return draft;
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

const RATIO = "Give the ratio as a number above 0 and at most 10.";

// A substitute's ratio as typed, if it is one: above 0 and at most 10.
function readRatio(ratio: string): number | undefined {
  const value = readNumber(ratio);
  return value === undefined || value <= 0 || value > 10 ? undefined : value;
}

// The API copies the numbers of a new FDC food and FDC portion from the FDC Snapshot.
export function substitutionEdit(
  lineId: string,
  index: number,
  ratio: string,
  note: string,
  food: { fdcId: number; portionId: number | null },
): Built {
  const value = readRatio(ratio);
  if (value === undefined) return { problem: RATIO, field: "Ratio" };
  return {
    edit: {
      kind: "substitution",
      line_id: lineId,
      index,
      ratio: value,
      note: note.trim(),
      fdc_id: food.fdcId,
      portion_id: food.portionId,
    },
  };
}

export function difficultyEdit({ prep, cook, cleanup }: DifficultyChoice): Built {
  if (!prep || !cook || !cleanup) return { problem: "Rate all of Prep, Cook and Cleanup." };
  return { edit: { kind: "difficulty", prep, cook, cleanup } };
}

// The line a substitute stands in for, as its form reads it: its unit, the parser's kind for it and
// whether it has an amount, which its FDC portion should fit, and its Canonical Ingredient.
export type SubstituteLine = {
  unit: string | null;
  unitKind: "mass" | "volume" | "count" | null;
  hasAmount: boolean;
  canonicalId: string | undefined;
};

// A substitute's name: its wording, else its Canonical Ingredient's name.
export function substituteName(
  substitute: SubstituteDraft,
  collection: Pick<Collection, "canonical_ingredients">,
): string {
  if (substitute.wording) return substitute.wording;
  const { canonical } = substitute;
  if (canonical.kind === "new") return canonical.name;
  return collection.canonical_ingredients.find((c) => c.id === canonical.id)?.name ?? "";
}

// At most this many substitutes for a line, as the API's MAX_SUBSTITUTES.
export const MAX_SUBSTITUTES = 5;

// A household substitute as its form holds it: the draft it started from, kept with its Canonical
// Ingredient and wording, or none for one added in the form, whose Canonical Ingredient is picked
// (`keep` until it is); its ratio and note as typed, and its FDC food and portion.
export type SubstituteEntry = {
  from: SubstituteDraft | null;
  pick: CanonicalPick;
  ratio: string;
  note: string;
  food: FoodPick;
};

export const substituteEntry = (from: SubstituteDraft): SubstituteEntry => ({
  from,
  pick: { kind: "keep" },
  ratio: String(from.ratio),
  note: from.note,
  food: { fdcId: from.fdc_id, portionId: from.portion_id, converts: false },
});

export const newSubstitute = (): SubstituteEntry => ({
  from: null,
  pick: { kind: "keep" },
  ratio: "1",
  note: "",
  food: null,
});

// The line's substitutes as Our Version saves them, or why not, naming the field at fault by its
// substitute's place (`ratio-1`). An added one's wording is its Canonical Ingredient's name, which
// can't be the line's own (`lineCanonical`).
export function substituteDrafts(
  entries: SubstituteEntry[],
  lineCanonical: string | undefined,
): Built<SubstituteDraft[]> {
  const drafts: SubstituteDraft[] = [];
  for (const [n, entry] of entries.entries()) {
    let canonical = entry.from?.canonical;
    if (!canonical) {
      const chosen = canonicalChoice(entry.pick);
      if ("problem" in chosen) return chosen;
      if (!chosen.edit)
        return {
          problem: "Choose the substitute’s Canonical Ingredient.",
          field: `canonical-${n}`,
        };
      canonical = chosen.edit;
    }
    if (canonical.kind === "existing" && canonical.id === lineCanonical)
      return {
        problem: "A substitute can’t be the line’s own Canonical Ingredient.",
        field: `canonical-${n}`,
      };
    if (!entry.food)
      return {
        problem: "Choose an FDC food for this substitute: the closest one if none fits.",
        field: `food-${n}`,
      };
    const ratio = readRatio(entry.ratio);
    if (ratio === undefined) return { problem: RATIO, field: `ratio-${n}` };
    drafts.push({
      canonical,
      wording: entry.from ? (entry.from.wording ?? null) : null,
      ratio,
      note: entry.note.trim(),
      fdc_id: entry.food.fdcId,
      portion_id: entry.food.portionId,
    });
  }
  return { edit: drafts };
}
