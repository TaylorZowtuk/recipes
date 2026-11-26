import { type AdjustChoices, lineView } from "./adjust";
import { kitchenNumber } from "./amount";
import type { IngredientFacts, Original, Recipe, RecipeFacts, Step, StepFacts } from "./api/client";

// Which of a recipe's versions shows: Our Version, when the recipe has one, or the Original.
export type Version = "ours" | "original";

type IngredientLine = Original["ingredients"][number];

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

const NO_FACTS: IngredientFacts = {
  parse: null,
  match: null,
  conversion: null,
  substitutions: null,
};

export const ADDED = "added in Our Version";
export const CHANGED = "changed in Our Version";

// The recipe as `version` shows it: its lines and steps in order and their facts by id. Our
// Version leaves out what it removes, replaces what it edits with its own line (and facts) or step
// (raw text, with no facts, until enrich segments it) and puts each added one after the one it
// names. An unchanged line or step keeps the Original's facts, apart from the substitutions Our
// Version holds for the line, even none, which replace the Original's; a step's segment for a line not
// among the effective lines shows as its words, with no amount, and its uses drop that line, as
// the API's `effective`.
export function effective(
  recipe: Pick<Recipe, "original" | "facts" | "our_version">,
  version: Version,
): { original: EffectiveOriginal; facts: RecipeFacts } {
  const ours = recipe.our_version;
  if (!ours || version === "original") return { original: recipe.original, facts: recipe.facts };
  const lineFacts: Record<string, IngredientFacts> = {};
  // An edited or added line's facts are Our Version's own.
  const ourFacts = (id: string) => {
    const facts = ours.facts.ingredients[id];
    if (facts) lineFacts[id] = facts;
  };
  const ingredients = overlay(
    recipe.original.ingredients,
    ours.ingredients,
    (line): EffectiveLine => {
      const edit = ours.ingredients.edit[line.id];
      const original = recipe.facts.ingredients[line.id];
      if (!edit) {
        // Our Version's household substitutions, even none, replace the Original's on the line.
        const household = ours.facts.ingredients[line.id]?.substitutions;
        if (household) lineFacts[line.id] = { ...(original ?? NO_FACTS), substitutions: household };
        else if (original) lineFacts[line.id] = original;
        return line;
      }
      ourFacts(line.id);
      const change = { kind: "edited" as const, was: line, wasFacts: original };
      return { id: line.id, component: edit.component, text: edit.text, change };
    },
    (added): EffectiveLine => {
      ourFacts(added.id);
      return {
        id: added.id,
        component: added.component,
        text: added.text,
        change: { kind: "added" },
      };
    },
  );
  const stepFacts: Record<string, StepFacts> = {};
  const kept = new Set(ingredients.map((line) => line.id));
  // An edited or added step's facts are Our Version's own, none until enrich segments it.
  const factsOf = (id: string, held: Record<string, StepFacts>) => {
    const facts = held[id];
    if (facts) stepFacts[id] = without(facts, kept);
  };
  const steps = overlay(
    recipe.original.steps,
    ours.steps,
    (step): EffectiveStep => {
      const edit = ours.steps.edit[step.id];
      factsOf(step.id, edit ? ours.facts.steps : recipe.facts.steps);
      if (edit)
        return { id: step.id, component: edit.component, text: edit.text, change: "edited" };
      return step;
    },
    ({ id, component, text }): EffectiveStep => {
      factsOf(id, ours.facts.steps);
      return { id, component, text, change: "added" };
    },
  );
  return {
    original: { ...recipe.original, ingredients, steps },
    facts: { ...recipe.facts, ingredients: lineFacts, steps: stepFacts },
  };
}

// The step's facts with each Segment for a line not in `kept` shown as its words, with no amount,
// and its uses only of the kept lines, as the API's `_without`.
function without(facts: StepFacts, kept: Set<string>): StepFacts {
  const { segments, uses } = facts;
  return {
    ...facts,
    ...(segments && {
      segments: {
        ...segments,
        segments: segments.segments.map((segment) =>
          segment.t === "ingredient" && !kept.has(segment.ref)
            ? { t: "text" as const, v: segment.written }
            : segment,
        ),
      },
    }),
    ...(uses && { uses: { ...uses, uses: uses.uses.filter((use) => kept.has(use.ref)) } }),
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

// A substitute as it shows under its line: "or coconut oil (×¾) · melt it first".
export function substituteText({
  wording,
  ratio,
  note,
}: {
  wording: string;
  ratio: number;
  note: string;
}) {
  return `or ${wording} (×${kitchenNumber(ratio)})${note ? ` · ${note}` : ""}`;
}
