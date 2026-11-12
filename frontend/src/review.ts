import { api, type Card, type Collection, type Recipe, type RecipeFacts } from "./api/client";
import type { components } from "./api/schema";
import { reloadCollection, rememberRecipe } from "./collection";
import { CHANGED_ELSEWHERE, CHANGED_NOT_REFRESHED, UNREACHABLE } from "./editRecipe";
import type { ToastMessage } from "./Toast";
import { type Answer, refusalMessage, versionedRefusal, type WriteRefusal } from "./writeOutcome";

export type FactEdit = components["schemas"]["EditFact"]["edit"];
export type EnrichmentIssue = components["schemas"]["EnrichmentIssue-Output"];
type NeedsReview = Card["needs_review"];
export type ReviewTab = "ingredients" | "steps" | "about";
export type Mark = "unchecked" | "flagged" | "confirmed";
export type ReviewItemKind = "line" | "step" | "substitutions" | "difficulty";
export type ReviewItem = {
  id: string;
  kind: ReviewItemKind;
  tab: ReviewTab;
  // The item's facts, and any fact an open Enrichment Issue of it is on: what confirming it sends.
  factIds: string[];
  mark: Mark;
  issues: EnrichmentIssue[];
};

type Fact = { confirmed: boolean };

const LINE_ITEM = ["parse", "match", "conversion"] as const;
const STEP_ITEM = ["segments", "uses"] as const;

// The Review Item a fact belongs to: `i3.match` to `i3`, `i3.substitutions` to itself.
const itemOf = (factId: string) =>
  factId === "difficulty" || factId.endsWith(".substitutions")
    ? factId
    : (factId.split(".")[0] ?? factId);

// Each Review Item's fact paths, by the item's id, for the facts the recipe has: as the API's
// `review_items`, a line's parse, match and conversion, its substitutions, a step's segments and
// uses, and the suggested Difficulty unless the editor set the recipe's own. An open Enrichment
// Issue's fact joins its item, which it makes if the recipe lacks the item's facts.
export function reviewItems(recipe: Recipe): Record<string, string[]> {
  const { facts } = recipe;
  const items: Record<string, string[]> = {};
  for (const [lineId, line] of Object.entries(facts.ingredients)) {
    items[lineId] = LINE_ITEM.filter((kind) => line[kind]).map((kind) => `${lineId}.${kind}`);
    if (line.substitutions) items[`${lineId}.substitutions`] = [`${lineId}.substitutions`];
  }
  for (const [stepId, step] of Object.entries(facts.steps)) {
    items[stepId] = STEP_ITEM.filter((kind) => step[kind]).map((kind) => `${stepId}.${kind}`);
  }
  if (facts.difficulty && !recipe.difficulty) items.difficulty = ["difficulty"];
  const withFacts = Object.fromEntries(Object.entries(items).filter(([, p]) => p.length > 0));
  for (const issue of recipe.issues.filter((issue) => issue.status === "open")) {
    const id = itemOf(issue.fact_id);
    const paths = withFacts[id] ?? [];
    if (!paths.includes(issue.fact_id)) withFacts[id] = [...paths, issue.fact_id];
  }
  return withFacts;
}

export function factAt(facts: RecipeFacts, path: string): Fact | null {
  if (path === "difficulty") return facts.difficulty;
  const [owner = "", kind = ""] = path.split(".");
  const holder: Record<string, unknown> | undefined =
    facts.ingredients[owner] ?? facts.steps[owner];
  return (holder?.[kind] as Fact | null | undefined) ?? null;
}

// The recipe's Review Items in order, each with its tab and mark: flagged while an open
// Enrichment Issue is on any of its facts, else unchecked while any fact is unconfirmed.
export function reviewOf(recipe: Recipe): Map<string, ReviewItem> {
  const stepIds = new Set(recipe.original.steps.map((step) => step.id));
  const open = recipe.issues.filter((issue) => issue.status === "open");
  const items = new Map<string, ReviewItem>();
  for (const [id, paths] of Object.entries(reviewItems(recipe))) {
    const issues = open.filter((issue) => itemOf(issue.fact_id) === id);
    const unconfirmed = paths.some((path) => !factAt(recipe.facts, path)?.confirmed);
    const kind: ReviewItemKind =
      id === "difficulty"
        ? "difficulty"
        : id.endsWith(".substitutions")
          ? "substitutions"
          : stepIds.has(id)
            ? "step"
            : "line";
    items.set(id, {
      id,
      kind,
      tab: kind === "difficulty" ? "about" : kind === "step" ? "steps" : "ingredients",
      factIds: paths,
      mark: issues.length ? "flagged" : unconfirmed ? "unchecked" : "confirmed",
      issues,
    });
  }
  return items;
}

const onTab = (items: Map<string, ReviewItem>, tab: ReviewTab) =>
  [...items.values()].filter((item) => item.tab === tab);

// What is left to review of the items, or of a tab's, counted as a card's `needs_review` is:
// every item still to check, the flagged ones among them, and their open Enrichment Issues.
export function reviewLeft(items: Map<string, ReviewItem>, tab?: ReviewTab): NeedsReview {
  const left = tab ? onTab(items, tab) : [...items.values()];
  return {
    unconfirmed: left.filter((item) => item.mark !== "confirmed").length,
    flagged: left.filter((item) => item.mark === "flagged").length,
    open_issues: left.reduce((n, item) => n + item.issues.length, 0),
  };
}

// How many of each tab's items an editor has still to check, as the tab's review bar counts them.
export function tabCounts(items: Map<string, ReviewItem>): Record<ReviewTab, number> {
  const count = (tab: ReviewTab) => reviewLeft(items, tab).unconfirmed;
  return { ingredients: count("ingredients"), steps: count("steps"), about: count("about") };
}

// The unchecked items on a tab, which Confirm N on this tab confirms. Never a flagged one.
export const uncheckedOn = (items: Map<string, ReviewItem>, tab: ReviewTab) =>
  onTab(items, tab).filter((item) => item.mark === "unchecked");

export const confirmableOn = (items: Map<string, ReviewItem>, tab: ReviewTab) =>
  uncheckedOn(items, tab).flatMap((item) => item.factIds);

export type ReviewOutcome =
  | { kind: "confirmed"; recipe: Recipe; batch: string; ready: boolean }
  | { kind: "undone"; recipe: Recipe }
  | {
      kind: "edited";
      recipe: Recipe;
      ready: boolean;
      alsoUpdated: number;
      notUpdated: number;
      tooBig: number;
      // The line's Canonical Ingredient, picking which again retries those not updated.
      canonical?: string;
    }
  | WriteRefusal;

// Confirms the facts as one Confirm Batch at the recipe's version.
export async function confirmItems(recipe: Recipe, factIds: string[]): Promise<ReviewOutcome> {
  const answer = await api.POST("/api/recipes/{recipe_id}/confirm", {
    params: { path: { recipe_id: recipe.id } },
    body: { version: recipe.version, fact_ids: factIds },
  });
  const { data } = answer;
  return answer.response.status === 200 && data
    ? { kind: "confirmed", recipe: data.recipe, batch: data.confirm_batch, ready: data.ready }
    : versionedRefusal(answer as Answer<unknown>);
}

// Reverses exactly that Confirm Batch. A 404 means nothing carries it any more: changed elsewhere.
export async function undoBatch(recipe: Recipe, batch: string): Promise<ReviewOutcome> {
  const answer = await api.POST("/api/recipes/{recipe_id}/confirm-batches/{batch}/undo", {
    params: { path: { recipe_id: recipe.id, batch } },
  });
  const { data } = answer;
  return answer.response.status === 200 && data
    ? { kind: "undone", recipe: data }
    : versionedRefusal(answer as Answer<unknown>);
}

// Saves an editor's edit of one Review Item at the recipe's version. A 422 says why it can't.
export async function editFact(
  recipe: Recipe,
  edit: FactEdit,
): Promise<ReviewOutcome | { kind: "invalid"; message: string }> {
  const answer = await api.POST("/api/recipes/{recipe_id}/edit", {
    params: { path: { recipe_id: recipe.id } },
    body: { version: recipe.version, edit },
  });
  const { data } = answer;
  if (answer.response.status === 200 && data)
    return {
      kind: "edited",
      recipe: data.recipe,
      ready: data.ready,
      alsoUpdated: data.also_updated.length,
      notUpdated: data.not_updated.length,
      tooBig: data.too_big.length,
    };
  const message = answer.response.status === 422 && refusalMessage(answer.error);
  return message ? { kind: "invalid", message } : versionedRefusal(answer as Answer<unknown>);
}

// The name of the Canonical Ingredient a line edit picks: a new one isn't in the Collection yet.
function pickedName(
  edit: FactEdit,
  collection: Pick<Collection, "canonical_ingredients">,
): string | undefined {
  if (edit.kind !== "line" || !edit.canonical) return undefined;
  const pick = edit.canonical;
  return pick.kind === "new"
    ? pick.name
    : collection.canonical_ingredients.find((c) => c.id === pick.id)?.name;
}

// Saves the edit and settles it as a confirm is, except that an edit has no Undo. A saved edit or a
// conflict gives a toast, once the newer recipe is shown; anything else is a problem for the form,
// which stays open with what the editor typed.
export async function runEdit(
  recipe: Recipe,
  edit: FactEdit,
  collection: Pick<Collection, "canonical_ingredients">,
): Promise<{ toast: ToastMessage } | { problem: string }> {
  let outcome: Awaited<ReturnType<typeof editFact>>;
  try {
    outcome = await editFact(recipe, edit);
  } catch {
    return { problem: UNREACHABLE };
  }
  if (outcome.kind === "invalid") return { problem: outcome.message };
  const canonical = pickedName(edit, collection);
  const settled = outcome.kind === "edited" && canonical ? { ...outcome, canonical } : outcome;
  const toast = await runReview(async () => settled);
  return settled.kind === "edited" || settled.kind === "conflict"
    ? { toast }
    : { problem: toast.text };
}

const READY_REST = " This recipe is now Ready, so it joins the Grocery List and fridge matching.";
export const READY_TOAST = `Confirmed.${READY_REST}`;
const NOT_REFRESHED = " Couldn’t refresh, so reload to see the latest.";

// Runs a review write and settles it as edits do: a written recipe is remembered and the
// Collection reloaded, as it is on a conflict, so the page shows the newer recipe. An undo that
// couldn't reach Plateful keeps its Confirm Batch (`retry`) on the toast, so Undo can try again.
export async function runReview(
  write: () => Promise<ReviewOutcome>,
  retry?: string,
): Promise<ToastMessage> {
  let outcome: ReviewOutcome;
  try {
    outcome = await write();
  } catch {
    outcome = { kind: "failed" };
  }
  if (outcome.kind === "confirmed" || outcome.kind === "undone" || outcome.kind === "edited")
    rememberRecipe(outcome.recipe);
  const refreshed =
    outcome.kind === "failed" || outcome.kind === "not-an-editor" || (await reloadCollection());
  const stale = refreshed ? "" : NOT_REFRESHED;
  switch (outcome.kind) {
    case "confirmed":
      return { text: (outcome.ready ? READY_TOAST : "Confirmed.") + stale, undo: outcome.batch };
    case "undone":
      return { text: `Undone.${stale}` };
    case "edited": {
      const others = (n: number) => `${n} other ${n === 1 ? "recipe" : "recipes"}`;
      const { alsoUpdated: also, notUpdated: not, tooBig: big } = outcome;
      const changed = also ? ` ${others(also)} with the same wording changed too.` : "";
      // Picking the line's Canonical Ingredient again retries the recipes that kept changing, but
      // not those too big. Only a pick reaches other recipes, so one that wasn't updated has a name.
      const missed = not
        ? ` ${others(not)} with the same wording ${not === 1 ? "wasn’t" : "weren’t"} updated. Choose ${outcome.canonical ?? "its Canonical Ingredient"} again for this line to retry.`
        : "";
      const tooBig = big
        ? ` ${others(big)} with the same wording ${big === 1 ? "is" : "are"} too big to update.`
        : "";
      return {
        text: `Saved as Confirmed.${outcome.ready ? READY_REST : ""}${changed}${missed}${tooBig}${stale}`,
      };
    }
    case "conflict":
      return { text: refreshed ? CHANGED_ELSEWHERE : CHANGED_NOT_REFRESHED };
    case "not-an-editor":
      return { text: "Only the household’s editors can review recipes. Sign in again." };
    default:
      return { text: "Couldn’t reach Plateful. Try again.", ...(retry && { undo: retry }) };
  }
}
