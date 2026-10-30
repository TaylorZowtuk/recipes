import {
  type Answer,
  chosenDifficulty,
  type DifficultyChoice,
  parseTags,
  type Refusal,
  refusal,
} from "./addRecipe";
import type { Difficulty, Preview, Recipe, RecipeOperation } from "./api/client";

// An editor's Draft: the recipe's Difficulty, Tags and Preview Photo as Edit shows them. It lives
// only in the recipe page's state, so Cancel or leaving the page discards it.
export type Draft = { difficulty: DifficultyChoice; tags: string; preview: Preview | null };

export const RATE_ALL = "Rate all of Prep, Cook and Cleanup, or clear them.";
export const CHANGED_ELSEWHERE =
  "This recipe changed on another device. Showing the newer version.";
const NOT_AN_EDITOR = "Only the household’s editors can edit recipes. Sign in again.";
const UNREACHABLE = "Couldn’t reach Plateful. Try again.";

export function draftOf(recipe: Recipe): Draft {
  return {
    difficulty: recipe.difficulty ?? {},
    tags: recipe.tags.join(", "),
    preview: recipe.preview,
  };
}

const sameDifficulty = (a: Difficulty | null, b: Difficulty | null) =>
  a === b || (!!a && !!b && a.prep === b.prep && a.cook === b.cook && a.cleanup === b.cleanup);

const samePreview = (a: Preview | null, b: Preview | null) =>
  a === b ||
  (!!a && !!b && a.image_id === b.image_id && a.focal_x === b.focal_x && a.focal_y === b.focal_y);

const sameTags = (a: string[], b: string[]) =>
  a.length === b.length && a.every((tag, i) => tag === b[i]);

// Which of Difficulty, Tags and Preview Photo the draft changes. A part-rated Difficulty counts as
// a change, though it can't be saved until it's whole or cleared.
function changes(recipe: Recipe, draft: Draft) {
  const chosen = chosenDifficulty(draft.difficulty);
  return {
    difficulty: !chosen.complete || !sameDifficulty(chosen.difficulty, recipe.difficulty),
    tags: !sameTags(parseTags(draft.tags), recipe.tags),
    preview: !samePreview(draft.preview, recipe.preview),
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
  return operations;
}

export const saveLabel = (count: number) => `Save ${count} ${count === 1 ? "change" : "changes"}`;

export type EditOutcome = { kind: "saved"; recipe: Recipe } | Refusal;
export type DeleteOutcome = { kind: "deleted" } | Refusal;

// What `PATCH /api/recipes/{id}` answered: the saved recipe (200), or why not. A 409 is a stale
// version: the recipe changed elsewhere.
export function editOutcome(answer: Answer<Recipe>): EditOutcome {
  const { data, response } = answer;
  return response.status === 200 && data ? { kind: "saved", recipe: data } : refusal(answer);
}

export function deleteOutcome(answer: Answer<unknown>): DeleteOutcome {
  return answer.response.status === 204 ? { kind: "deleted" } : refusal(answer);
}

// Edit on the recipe page: a draft while editing, null while read-only. A conflict discards the
// draft, since the newer recipe shows instead and nothing is merged; any other failure keeps it.
type EditState = { draft: Draft | null; problem?: string; notice?: string };

export type EditAction =
  | { type: "open"; recipe: Recipe }
  | { type: "change"; change: Partial<Draft> }
  | { type: "cancel" }
  | { type: "incomplete" }
  | { type: "settled"; outcome: EditOutcome | DeleteOutcome };

export function editing(state: EditState, action: EditAction): EditState {
  switch (action.type) {
    case "open":
      return { draft: draftOf(action.recipe) };
    case "change":
      return state.draft ? { ...state, draft: { ...state.draft, ...action.change } } : state;
    case "cancel":
      return { draft: null };
    case "incomplete":
      return { ...state, problem: RATE_ALL };
    case "settled":
      switch (action.outcome.kind) {
        case "saved":
        case "deleted":
          return { draft: null };
        case "conflict":
          return { draft: null, notice: CHANGED_ELSEWHERE };
        case "not-an-editor":
          return { ...state, problem: NOT_AN_EDITOR };
        default:
          return { ...state, problem: UNREACHABLE };
      }
  }
}
