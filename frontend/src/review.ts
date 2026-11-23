import { api, type Card, type Collection, type Recipe, type RecipeFacts } from "./api/client";
import type { components } from "./api/schema";
import { reloadCollection, rememberRecipe } from "./collection";
import { CHANGED_ELSEWHERE, CHANGED_NOT_REFRESHED, UNREACHABLE } from "./editRecipe";
import { effective } from "./ourVersion";
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
  // The item's facts, and any fact an open Enrichment Issue of it is on (`confirmedBy` says which
  // of them confirming it sends).
  factIds: string[];
  mark: Mark;
  issues: EnrichmentIssue[];
};

type Fact = { confirmed: boolean };

const LINE_ITEM = ["parse", "match", "conversion"] as const;
const STEP_ITEM = ["segments", "uses"] as const;

// The prefix of a fact's path, and of a Review Item's id, in Our Version: `our_version.i4.match`.
export const OUR_VERSION = "our_version.";

// The Review Item a fact belongs to: `i3.match` to `i3`, `i3.substitutions` to itself, and
// `our_version.s2.uses` to `our_version.s2`.
const itemOf = (factId: string): string => {
  if (factId.startsWith(OUR_VERSION)) return OUR_VERSION + itemOf(factId.slice(OUR_VERSION.length));
  return factId === "difficulty" || factId.endsWith(".substitutions")
    ? factId
    : (factId.split(".")[0] ?? factId);
};

const openIssues = (recipe: Recipe) => recipe.issues.filter((issue) => issue.status === "open");

// The Review Items of the lines and steps in `facts`, their ids and paths under `prefix`.
function itemsIn(facts: RecipeFacts, prefix: string): Record<string, string[]> {
  const items: Record<string, string[]> = {};
  for (const [lineId, line] of Object.entries(facts.ingredients)) {
    const owner = `${prefix}${lineId}`;
    items[owner] = LINE_ITEM.filter((kind) => line[kind]).map((kind) => `${owner}.${kind}`);
    if (line.substitutions) items[`${owner}.substitutions`] = [`${owner}.substitutions`];
  }
  for (const [stepId, step] of Object.entries(facts.steps)) {
    const owner = `${prefix}${stepId}`;
    items[owner] = STEP_ITEM.filter((kind) => step[kind]).map((kind) => `${owner}.${kind}`);
  }
  return items;
}

// Each Review Item's fact paths, by the item's id, for the facts the recipe has: as the API's
// `review_items`, a line's parse, match and conversion, its substitutions, a step's segments and
// uses, and the suggested Difficulty unless the editor set the recipe's own. Our Version's facts
// make its own items, prefixed (`our_version.s2`), beside the Original's. An open Enrichment
// Issue's fact joins its item, which it makes if the recipe lacks the item's facts.
export function reviewItems(recipe: Recipe): Record<string, string[]> {
  const { facts } = recipe;
  const items = itemsIn(facts, "");
  if (facts.difficulty && !recipe.difficulty) items.difficulty = ["difficulty"];
  if (recipe.our_version) Object.assign(items, itemsIn(recipe.our_version.facts, OUR_VERSION));
  const withFacts = Object.fromEntries(Object.entries(items).filter(([, p]) => p.length > 0));
  for (const issue of openIssues(recipe)) {
    const id = itemOf(issue.fact_id);
    const paths = withFacts[id] ?? [];
    if (!paths.includes(issue.fact_id)) withFacts[id] = [...paths, issue.fact_id];
  }
  return withFacts;
}

// The fact at `path` in the Original's facts, or in Our Version's for `our_version.s2.uses`.
export function factOf(recipe: Recipe, path: string): Fact | null {
  if (!path.startsWith(OUR_VERSION)) return factAt(recipe.facts, path);
  const ours = recipe.our_version;
  return ours ? factAt(ours.facts, path.slice(OUR_VERSION.length)) : null;
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
// An Our Version item is a step's when it is one of the Original's steps or one Our Version adds.
export function reviewOf(recipe: Recipe): Map<string, ReviewItem> {
  const added = recipe.our_version?.steps.add ?? [];
  const stepIds = new Set([...recipe.original.steps, ...added].map((step) => step.id));
  const open = openIssues(recipe);
  const items = new Map<string, ReviewItem>();
  for (const [id, paths] of Object.entries(reviewItems(recipe))) {
    const issues = open.filter((issue) => itemOf(issue.fact_id) === id);
    const unconfirmed = paths.some((path) => !factOf(recipe, path)?.confirmed);
    const kind: ReviewItemKind =
      id === "difficulty"
        ? "difficulty"
        : id.endsWith(".substitutions")
          ? "substitutions"
          : stepIds.has(ownerOf(id).owner)
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

// The line, step or Difficulty a Review Item is of, and whether it is Our Version's:
// `our_version.s2` is Our Version's step s2, `i3.substitutions` the Original's line i3.
export function ownerOf(id: string): { owner: string; ours: boolean } {
  const ours = id.startsWith(OUR_VERSION);
  const [owner = ""] = (ours ? id.slice(OUR_VERSION.length) : id).split(".");
  return { owner, ours };
}

// The recipe a Review Item's facts and text are in, and its line's or step's id there: the
// effective recipe for an Our Version item, whose lines and facts are Our Version's, else the
// Original.
export function itemRecipe(
  item: ReviewItem,
  recipe: Recipe,
): { owner: string; seen: Pick<Recipe, "original" | "facts"> } {
  const { owner, ours } = ownerOf(item.id);
  return { owner, seen: ours ? effective(recipe, "ours") : recipe };
}

// The Review Item a line or step shows as: in Our Version its own item when it has one, else the
// Original's, which an edited or added one doesn't show.
export function shownItem(
  review: { items: Map<string, ReviewItem>; ours?: boolean },
  id: string,
  changed: boolean,
): ReviewItem | undefined {
  const mine = review.ours ? review.items.get(OUR_VERSION + id) : undefined;
  return mine ?? (changed ? undefined : review.items.get(id));
}

// Whether confirming the item settles its open issues as they are: on a step, an issue proposing
// no correction (one an Our Version edit left) is settled by confirming the step as it is.
const settlesAsItIs = (item: ReviewItem, issue: EnrichmentIssue) =>
  issue.after !== null || item.kind === "step";

// Whether the item's sheet offers Confirm, or Accept correction while flagged: not once it's
// Confirmed, nor while every open issue on a line proposes no correction (one asking an editor to
// pick an FDC portion or FDC food), which the editor settles by editing the item instead.
export const acceptable = (item: ReviewItem) =>
  item.mark !== "confirmed" &&
  (item.mark !== "flagged" || item.issues.some((issue) => settlesAsItIs(item, issue)));

// What the sheet's confirm button says: Accept correction while an open issue proposes one.
export const confirmLabel = (item: ReviewItem) =>
  item.issues.some((issue) => issue.after !== null) ? "Accept correction" : "Confirm";

// The fact ids confirming the item sends: not one that only an open issue on a line proposing no
// correction is on, so accepting another issue's correction leaves that ask open, and the item
// flagged, until an edit settles it.
export const confirmedBy = (item: ReviewItem) =>
  item.factIds.filter(
    (id) =>
      !item.issues.some((issue) => issue.fact_id === id) ||
      item.issues.some((issue) => issue.fact_id === id && settlesAsItIs(item, issue)),
  );

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
