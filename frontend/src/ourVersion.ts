import { type AdjustChoices, lineView } from "./adjust";
import type { IngredientFacts, Original, Recipe, RecipeFacts, Step, StepFacts } from "./api/client";

// Which of a recipe's versions shows: Our Version, when the recipe has one, or the Original.
export type Version = "ours" | "original";

type IngredientLine = Original["ingredients"][number];
type OurVersion = NonNullable<Recipe["our_version"]>;

// How Our Version changed a line: edited, with the Original line it replaces and that line's
// facts, or added. An unchanged line has none.
export type LineChange =
  | { kind: "edited"; was: IngredientLine; wasFacts: IngredientFacts | undefined }
  | { kind: "added" };
export type EffectiveLine = IngredientLine & { change?: LineChange };
export type EffectiveStep = Step & { change?: "edited" | "added" };
export type EffectiveOriginal = Omit<Original, "ingredients" | "steps"> & {
  ingredients: EffectiveLine[];
  steps: EffectiveStep[];
};

export const ADDED = "added in Our Version";
export const CHANGED = "changed in Our Version";

// The recipe as `version` shows it: its lines and steps in order and their facts by id. Our
// Version leaves out what it removes, replaces what it edits with its own line (and facts) or step
// (raw text until enrich segments it) and puts each added one after the one it names. An unchanged
// line or step keeps the Original's facts, so a step's segment for a removed line shows its words.
export function effective(
  recipe: Pick<Recipe, "original" | "facts" | "our_version">,
  version: Version,
): { original: EffectiveOriginal; facts: RecipeFacts } {
  const ours = recipe.our_version;
  if (!ours || version === "original") return { original: recipe.original, facts: recipe.facts };
  const lineFacts: Record<string, IngredientFacts> = {};
  const factsOf = ({ parse, match, conversion }: OurVersion["ingredients"]["edit"][string]) => ({
    parse,
    match,
    conversion,
    substitutions: null,
  });
  const ingredients = overlay(
    recipe.original.ingredients,
    ours.ingredients,
    (line): EffectiveLine => {
      const edit = ours.ingredients.edit[line.id];
      const original = recipe.facts.ingredients[line.id];
      if (!edit) {
        if (original) lineFacts[line.id] = original;
        return line;
      }
      lineFacts[line.id] = factsOf(edit);
      const change = { kind: "edited" as const, was: line, wasFacts: original };
      return { id: line.id, component: edit.component, text: edit.text, change };
    },
    (added): EffectiveLine => {
      lineFacts[added.id] = factsOf(added);
      return {
        id: added.id,
        component: added.component,
        text: added.text,
        change: { kind: "added" },
      };
    },
  );
  const stepFacts: Record<string, StepFacts> = {};
  const steps = overlay(
    recipe.original.steps,
    ours.steps,
    (step): EffectiveStep => {
      const edit = ours.steps.edit[step.id];
      if (edit)
        return { id: step.id, component: edit.component, text: edit.text, change: "edited" };
      const facts = recipe.facts.steps[step.id];
      if (facts) stepFacts[step.id] = facts;
      return step;
    },
    ({ id, component, text }): EffectiveStep => ({ id, component, text, change: "added" }),
  );
  return {
    original: { ...recipe.original, ingredients, steps },
    facts: { ...recipe.facts, ingredients: lineFacts, steps: stepFacts },
  };
}

// The Original's items less the removed ones, each added item after the one its `after` names
// (first for none), several after the same one in the order Our Version lists them.
export function overlay<
  T extends { id: string },
  A extends { id: string; after: string | null },
  R,
>(
  items: T[],
  { remove, add }: { remove: string[]; add: A[] },
  kept: (item: T) => R,
  added: (item: A) => R,
): R[] {
  const out: R[] = [];
  const place = (after: string | null) => {
    for (const item of add)
      if (item.after === after) {
        out.push(added(item));
        place(item.id);
      }
  };
  place(null);
  for (const item of items) {
    if (remove.includes(item.id)) continue;
    out.push(kept(item));
    place(item.id);
  }
  return out;
}

// What Our Version changed on a line, quietly: "was ¾ cup" when only its amount or unit changed,
// shown with the same Adjust choices, else "was" and the replaced line as written, or that it was
// added. Nothing for an unchanged line.
export function lineNote(
  line: EffectiveLine,
  facts: IngredientFacts | undefined,
  choices: AdjustChoices,
): string | undefined {
  const { change } = line;
  if (!change) return undefined;
  if (change.kind === "added") return ADDED;
  const was = change.wasFacts;
  const [before, after] = [was?.parse, facts?.parse];
  if (
    was &&
    before &&
    after &&
    before.name === after.name &&
    before.preparation === after.preparation &&
    before.comment === after.comment
  ) {
    const plain = { scale: choices.scale, units: choices.units };
    const amount = lineView(was, plain).amount;
    if (amount && facts && amount !== lineView(facts, plain).amount) return `was ${amount}`;
  }
  return `was ${change.was.text}`;
}

export function stepNote(step: EffectiveStep): string | undefined {
  if (step.change === "edited") return CHANGED;
  if (step.change === "added") return ADDED;
  return undefined;
}
