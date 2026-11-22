import { chosenDifficulty, type DifficultyChoice, parseTags } from "./addRecipe";
import type { Difficulty, Preview, Recipe, RecipeOperation, Refused } from "./api/client";
import { type OurDraft, ourDraftOf, ourOperation, type Part } from "./ourVersionDraft";
import {
  type Answer,
  apiError,
  refusalMessage,
  versionedRefusal,
  type WriteRefusal,
} from "./writeOutcome";

// An editor's Draft: the recipe's Difficulty, Tags, Preview Photo and Our Version as Edit shows
// them. It lives only in the recipe page's state, so Cancel or leaving the page discards it.
export type Draft = {
  difficulty: DifficultyChoice;
  tags: string;
  preview: Preview | null;
  ours: OurDraft;
};

export const RATE_ALL = "Rate all of Prep, Cook and Cleanup, or clear them.";
export const CHANGED_ELSEWHERE =
  "This recipe changed on another device. Showing the newer version.";
// The conflict's notice once the reloaded Collection no longer has the recipe.
export const DELETED_ELSEWHERE = "This recipe was deleted on another device.";
// When the Collection reload after a write fails, the page still shows the old recipe.
export const SAVED_NOT_REFRESHED = "Saved, but couldn’t refresh. Reload to see the latest.";
// Setting the recipe's own Difficulty can leave nothing to review, so the save makes it Ready.
export const SAVED_READY =
  "Saved. This recipe is now Ready, so it joins the Grocery List and fridge matching.";
export const CHANGED_NOT_REFRESHED =
  "This recipe changed on another device, but couldn’t refresh. Reload to see the newer version.";
const NOT_AN_EDITOR = "Only the household’s editors can edit recipes. Sign in again.";
export const UNREACHABLE = "Couldn’t reach Plateful. Try again.";

export function draftOf(recipe: Recipe): Draft {
  return {
    difficulty: recipe.difficulty ?? {},
    tags: recipe.tags.join(", "),
    preview: recipe.preview,
    ours: ourDraftOf(recipe),
  };
}

const sameDifficulty = (a: Difficulty | null, b: Difficulty | null) =>
  a === b || (!!a && !!b && a.prep === b.prep && a.cook === b.cook && a.cleanup === b.cleanup);

const samePreview = (a: Preview | null, b: Preview | null) =>
  a === b ||
  (!!a && !!b && a.image_id === b.image_id && a.focal_x === b.focal_x && a.focal_y === b.focal_y);

const sameTags = (a: string[], b: string[]) =>
  a.length === b.length && a.every((tag, i) => tag === b[i]);

// Which of Difficulty, Tags, Preview Photo and Our Version the draft changes. A part-rated Difficulty counts as
// a change, though it can't be saved until it's whole or cleared.
function changes(recipe: Recipe, draft: Draft) {
  const chosen = chosenDifficulty(draft.difficulty);
  return {
    difficulty: !chosen.complete || !sameDifficulty(chosen.difficulty, recipe.difficulty),
    tags: !sameTags(parseTags(draft.tags), recipe.tags),
    preview: !samePreview(draft.preview, recipe.preview),
    ours: !!ourOperation(recipe, draft.ours),
  };
}

export function changeCount(recipe: Recipe, draft: Draft): number {
  return Object.values(changes(recipe, draft)).filter(Boolean).length;
}

// The PATCH operations for what the draft changes, or undefined while Difficulty is part-rated.
export function draftOperations(recipe: Recipe, draft: Draft): RecipeOperation[] | undefined {
  const chosen = chosenDifficulty(draft.difficulty);
  if (!chosen.complete) return undefined;
  const changed = changes(recipe, draft);
  const operations: RecipeOperation[] = [];
  if (changed.difficulty) operations.push({ op: "set_difficulty", difficulty: chosen.difficulty });
  if (changed.tags) operations.push({ op: "set_tags", tags: parseTags(draft.tags) });
  if (changed.preview) operations.push({ op: "set_preview", preview: draft.preview });
  const ours = ourOperation(recipe, draft.ours);
  if (ours) operations.push(ours);
  return operations;
}

export const saveLabel = (count: number) => `Save ${count} ${count === 1 ? "change" : "changes"}`;

// The Our Version line or step a refusal is about, by the id the draft gave it.
export type RefusedAt = { part: Part; id: string };

export type EditOutcome =
  | { kind: "saved"; recipe: Recipe }
  | { kind: "invalid"; message: string; at?: RefusedAt }
  | WriteRefusal;

// Where a 422 says the refused line or step is, else nowhere. The part is checked all the same,
// since a 422 from anything but the API wouldn't match the declared body.
function refusedAt(error: unknown): RefusedAt | undefined {
  const detail = (apiError(error) as Refused | undefined)?.detail;
  const first = Array.isArray(detail) ? detail[0] : undefined;
  if (!first || !("part" in first)) return undefined;
  const { part, id } = first;
  return (part === "ingredients" || part === "steps") && typeof id === "string"
    ? { part, id }
    : undefined;
}
export type DeleteOutcome = { kind: "deleted" } | WriteRefusal;

// What `PATCH /api/recipes/{id}` answered: the saved recipe (200), or why not. A 409 (a stale
// version) or a 404 (deleted) means the recipe changed elsewhere. A 422 says what the API refused,
// such as an Our Version line without its Canonical Ingredient.
export function editOutcome(answer: Answer<Recipe>): EditOutcome {
  const { data, response } = answer;
  if (response.status === 200 && data) return { kind: "saved", recipe: data };
  const message = response.status === 422 && refusalMessage(answer.error);
  if (!message) return versionedRefusal(answer);
  const at = refusedAt(answer.error);
  return at ? { kind: "invalid", message, at } : { kind: "invalid", message };
}

export function deleteOutcome(answer: Answer<unknown>): DeleteOutcome {
  return answer.response.status === 204 ? { kind: "deleted" } : versionedRefusal(answer);
}

// Edit on the recipe page: a draft while editing, null while read-only. A conflict discards the
// draft, since the newer recipe shows instead and nothing is merged; any other failure keeps it.
// `refreshed` says whether the Collection reloaded after the write, so the notice never claims
// the page shows what it doesn't.
// `at` is the Our Version line or step the problem is about, if any.
type EditState = { draft: Draft | null; problem?: string; at?: RefusedAt; notice?: string };

export type EditAction =
  | { type: "open"; recipe: Recipe }
  | { type: "change"; change: Partial<Draft> }
  | { type: "cancel" }
  | { type: "incomplete" }
  | {
      type: "settled";
      outcome: EditOutcome | DeleteOutcome;
      refreshed: boolean;
      nowReady?: boolean;
    };

export function editing(state: EditState, action: EditAction): EditState {
  switch (action.type) {
    case "open":
      return { draft: draftOf(action.recipe) };
    case "change":
      return state.draft ? { ...state, draft: { ...state.draft, ...action.change } } : state;
    case "cancel":
      return { draft: null };
    case "incomplete":
      return { ...state, problem: RATE_ALL, at: undefined };
    case "settled":
      switch (action.outcome.kind) {
        case "saved":
          if (!action.refreshed) return { draft: null, notice: SAVED_NOT_REFRESHED };
          return action.nowReady ? { draft: null, notice: SAVED_READY } : { draft: null };
        case "deleted":
          return { draft: null };
        case "conflict":
          return {
            draft: null,
            notice: action.refreshed ? CHANGED_ELSEWHERE : CHANGED_NOT_REFRESHED,
          };
        case "invalid":
          return { ...state, problem: action.outcome.message, at: action.outcome.at };
        case "not-an-editor":
          return { ...state, problem: NOT_AN_EDITOR, at: undefined };
        default:
          return { ...state, problem: UNREACHABLE, at: undefined };
      }
  }
}
