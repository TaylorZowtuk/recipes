import type { DifficultyChoice } from "./addRecipe";
import type { Collection, Recipe } from "./api/client";
import type { FactEdit } from "./review";

// What an editor's edit form holds for each kind of Review Item, as typed, and the edit it saves:
// or, when what's typed can't be saved, why not.

export type Built = { edit: FactEdit } | { problem: string };

// A line's name as parsed, else as written.
export function lineName(recipe: Recipe, lineId: string) {
  return (
    recipe.facts.ingredients[lineId]?.parse?.name ??
    recipe.original.ingredients.find((line) => line.id === lineId)?.text ??
    lineId
  );
}

// A number as an editor types it: "2", "1.5", "1/2" or "1 1/2". Undefined if it isn't one.
export function readNumber(text: string): number | undefined {
  const typed = /^(?:(\d*\.?\d+)|(?:(\d+)\s+)?(\d+)\/(\d+))$/.exec(text.trim());
  if (!typed) return undefined;
  const [, decimal, whole, top, bottom] = typed;
  if (decimal !== undefined) return Number(decimal);
  return Number(bottom) ? Number(whole ?? 0) + Number(top) / Number(bottom) : undefined;
}

const FRACTIONS: [number, string][] = [
  [1 / 8, "1/8"],
  [1 / 4, "1/4"],
  [1 / 3, "1/3"],
  [3 / 8, "3/8"],
  [1 / 2, "1/2"],
  [5 / 8, "5/8"],
  [2 / 3, "2/3"],
  [3 / 4, "3/4"],
  [7 / 8, "7/8"],
];

// A number as the form shows it, in the kitchen fractions an editor would type.
export function numberText(value: number): string {
  const whole = Math.floor(value);
  const fraction = FRACTIONS.find(([part]) => Math.abs(value - whole - part) < 0.001);
  if (fraction) return whole ? `${whole} ${fraction[1]}` : fraction[1];
  return String(Math.round(value * 1000) / 1000);
}

// Keep the line's Canonical Ingredient, choose another, or create one.
export type CanonicalPick =
  | { kind: "keep" }
  | { kind: "existing"; id: string }
  | { kind: "new"; name: string; family: string; storeCategoryId: string };

export type LineDraft = {
  low: string;
  high: string;
  unit: string;
  name: string;
  preparation: string;
  canonical: CanonicalPick;
  // Whether the line stays in its written unit, or null when it has no weight to keep or convert.
  keepWeight: boolean | null;
};

export function lineDraft(recipe: Recipe, lineId: string): LineDraft {
  const { parse, conversion } = recipe.facts.ingredients[lineId] ?? {};
  const quantity = parse?.quantity;
  return {
    low: quantity ? numberText(quantity.low) : "",
    high: quantity && quantity.high !== quantity.low ? numberText(quantity.high) : "",
    unit: parse?.unit ?? "",
    name: lineName(recipe, lineId),
    preparation: parse?.preparation ?? "",
    canonical: { kind: "keep" },
    keepWeight: conversion ? !!conversion.refused : null,
  };
}

// Whether the line's FDC food gives anything to convert it to a weight by.
export function canConvert(recipe: Recipe, lineId: string) {
  const conversion = recipe.facts.ingredients[lineId]?.conversion;
  return conversion?.density_g_per_ml != null || conversion?.grams_per_count != null;
}

const AMOUNT = "Give the amount as a number, such as 2, 1.5 or 1 1/2, or leave it empty.";

export function lineEdit(recipe: Recipe, lineId: string, draft: LineDraft): Built {
  const low = draft.low.trim() ? readNumber(draft.low) : null;
  const high = draft.high.trim() ? readNumber(draft.high) : low;
  if (low === undefined || high === undefined || (low === null && high !== null))
    return { problem: AMOUNT };
  if (low !== null && high !== null && high < low)
    return { problem: "The amount’s upper end can’t be below its lower end." };
  const name = draft.name.trim();
  if (!name) return { problem: "Give the ingredient a name." };
  const edit: FactEdit = {
    kind: "line",
    line_id: lineId,
    quantity: low !== null && high !== null ? { low, high } : null,
    unit: draft.unit.trim() || null,
    name,
    preparation: draft.preparation.trim() || null,
  };
  const pick = draft.canonical;
  if (pick.kind === "existing") edit.canonical = { kind: "existing", id: pick.id };
  if (pick.kind === "new") {
    const family = pick.family.trim().toLowerCase();
    if (!pick.name.trim()) return { problem: "Give the new Canonical Ingredient a name." };
    if (!family || !pick.storeCategoryId)
      return { problem: "Give the new Canonical Ingredient a family and a Store Category." };
    edit.canonical = {
      kind: "new",
      name: pick.name.trim(),
      family,
      store_category_id: pick.storeCategoryId,
    };
  }
  // A new Canonical Ingredient brings its own weight, if any, so the choice is only for the kept one.
  const was = lineDraft(recipe, lineId).keepWeight;
  if (pick.kind === "keep" && draft.keepWeight !== null && draft.keepWeight !== was)
    edit.keep_weight = draft.keepWeight;
  return { edit };
}

// What changing the line's Canonical Ingredient does beyond this line, or null when it's kept.
export function canonicalNote(
  draft: LineDraft,
  collection: Pick<Collection, "canonical_ingredients">,
): string | null {
  const pick = draft.canonical;
  if (pick.kind === "keep") return null;
  const chosen =
    pick.kind === "new"
      ? pick.name.trim()
      : (collection.canonical_ingredients.find((c) => c.id === pick.id)?.name ?? "it");
  const weight =
    pick.kind === "new"
      ? "With no FDC food yet, the line has no weight or nutrition."
      : `Without another line matched to ${chosen} with an FDC food, this line has no weight or nutrition.`;
  return `Saving matches every line worded “${draft.name.trim()}” to ${chosen}, in every recipe. ${weight}`;
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

// A timer's range in minutes, as typed.
export type StepDraft = { portions: string[]; timers: { low: string; high: string }[] };

export function stepDraft(recipe: Recipe, stepId: string): StepDraft {
  const rows = stepRows(recipe, stepId);
  return {
    portions: rows.portions.map((row) => numberText(row.portion)),
    timers: rows.timers.map((timer) => ({
      low: numberText(timer.low_s / 60),
      high: numberText(timer.high_s / 60),
    })),
  };
}

export function stepEdit(stepId: string, draft: StepDraft): Built {
  const portions = draft.portions.map(readNumber);
  if (portions.some((portion) => portion === undefined || portion <= 0 || portion > 1))
    return { problem: "Give each portion as a number above 0 and at most 1, such as 1/2." };
  const durations = draft.timers.map(({ low, high }) => ({
    low_s: Math.round((readNumber(low) ?? Number.NaN) * 60),
    high_s: Math.round((readNumber(high) ?? Number.NaN) * 60),
  }));
  if (durations.some(({ low_s, high_s }) => !(low_s > 0) || !(high_s >= low_s)))
    return {
      problem: "Give each timer in minutes above 0, its upper end not below its lower end.",
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
    return { problem: "Give the ratio as a number above 0 and at most 10." };
  return {
    edit: { kind: "substitution", line_id: lineId, index, ratio: value, note: note.trim() },
  };
}

export function difficultyEdit({ prep, cook, cleanup }: DifficultyChoice): Built {
  if (!prep || !cook || !cleanup) return { problem: "Rate all of Prep, Cook and Cleanup." };
  return { edit: { kind: "difficulty", prep, cook, cleanup } };
}
