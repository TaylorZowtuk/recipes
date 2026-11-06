import type { CanonicalIngredient, KitchenSettings, StoreCategoryOperation } from "./api/client";
import { SAVED_NOT_REFRESHED, UNREACHABLE } from "./editRecipe";
import type { BatchOutcome, WriteRefusal } from "./writeOutcome";

// A Store Category in a Draft. A saved category's key is its id; an added one isn't saved yet.
export type DraftCategory = { key: string; name: string; added?: boolean };

// An editor's Draft of the Store Categories, in the order Edit shows them: the saved categories
// still in the list, then the added ones. `base` is the list it opened on: everything is worked out
// from that and saved at its version, so a Collection reload under an open Draft changes nothing
// here, and a list changed elsewhere is a conflict on Save. `deletes` keeps the order they were made.
export type Draft = {
  base: KitchenSettings;
  categories: DraftCategory[];
  deletes: { id: string; moveTo: string }[];
  addedSoFar: number;
};

export const BLANK_NAME = "Each Store Category needs a name.";
export const DUPLICATE_NAME = "Two Store Categories have the same name.";
export const CHANGED_ELSEWHERE =
  "The Kitchen settings changed on another device. Showing the newer version.";
export const CHANGED_NOT_REFRESHED =
  "The Kitchen settings changed on another device, but couldn’t refresh. Reload to see the newer version.";
const NOT_AN_EDITOR = "Only the household’s editors can change Kitchen settings. Sign in again.";

export function draftOf(settings: KitchenSettings): Draft {
  return {
    base: settings,
    categories: settings.store_categories.map(({ id, name }) => ({ key: id, name })),
    deletes: [],
    addedSoFar: 0,
  };
}

// The PATCH operations for what the Draft changes, in an order the API accepts for any Draft:
// renames, deletes in the order they were made, so each target is still there when it's used, one
// reorder of the saved categories left if their order changed, then adds.
export function draftOperations({ base, categories, deletes }: Draft): StoreCategoryOperation[] {
  const kept = categories.filter((category) => !category.added);
  const keptIds = kept.map((category) => category.key);
  const survivors = base.store_categories.map(({ id }) => id).filter((id) => keptIds.includes(id));
  return [
    ...kept.flatMap(({ key: id, name }): StoreCategoryOperation[] => {
      const before = base.store_categories.find((category) => category.id === id);
      return name.trim() !== before?.name ? [{ op: "rename", id, name: name.trim() }] : [];
    }),
    ...deletes.map(
      ({ id, moveTo }): StoreCategoryOperation => ({ op: "delete", id, move_to: moveTo }),
    ),
    ...(survivors.some((id, index) => id !== keptIds[index])
      ? [{ op: "reorder" as const, ids: keptIds }]
      : []),
    ...categories
      .filter((category) => category.added)
      .map(({ name }): StoreCategoryOperation => ({ op: "add", name: name.trim() })),
  ];
}

export const changeCount = (draft: Draft) => draftOperations(draft).length;

// Whether the category at `index` can swap with its neighbour. An added category has no place among
// the saved ones until it's saved: it can't move, and a saved one can't move below it.
export function canMove({ categories }: Draft, index: number, by: -1 | 1) {
  const category = categories[index];
  const neighbour = categories[index + by];
  return !!category && !!neighbour && !category.added && !neighbour.added;
}

const savedIn = ({ categories }: Draft) => categories.filter((category) => !category.added);

// Whether a row's grip works: the same rule as `canMove`, among the saved rows only.
export const canDrag = (draft: Draft, key: string) =>
  savedIn(draft).length > 1 && savedIn(draft).some((category) => category.key === key);

export type DragShift = { from: number; to: number; dy: number; stride: number };

// The index a row dragged `dy` from index `from` lands on, among `count` draggable rows of one
// height: past each row it has half covered. It can't land among the added rows below them.
export function dropIndex(from: number, dy: number, stride: number, count: number) {
  return Math.min(Math.max(from + Math.round(dy / stride), 0), count - 1);
}

// How far a row dragged `dy` from index `from` is drawn, among `count` draggable rows: no further
// than the first and last places. Past those its transform would lengthen the page, and a scroll
// at the window's edge would chase that new length.
export function dragReach(from: number, dy: number, stride: number, count: number) {
  return Math.min(Math.max(dy, (0 - from) * stride), (count - 1 - from) * stride);
}

// How far the row at `index` sits from its place mid-drag: the dragged row follows the pointer, and
// those it has passed slide over by one row.
export function dragOffset({ from, to, dy, stride }: DragShift, index: number) {
  if (index === from) return dy;
  if (index > from && index <= to) return -stride;
  if (index < from && index >= to) return stride;
  return 0;
}

// Where a deleted category's Canonical Ingredients can go: a saved category still in the Draft,
// since the API mints an added one's id. With none left, the category can't be deleted.
export const moveTargets = (draft: Draft, key: string) =>
  savedIn(draft).filter((category) => category.key !== key);

// How many Canonical Ingredients would leave a category, counting those the Draft's earlier deletes
// moved into it.
export function ingredientsMoving(ingredients: CanonicalIngredient[], draft: Draft, key: string) {
  const placed = (category: string) =>
    draft.deletes.reduce((at, { id, moveTo }) => (at === id ? moveTo : at), category);
  return ingredients.filter(({ store_category_id: id }) => placed(id) === key).length;
}

// What the API would refuse in the Draft's final list, read as a sentence with no round trip. The
// API's own message still shows for anything this misses.
export function draftProblem({ categories }: Draft): string | null {
  const names = categories.map(({ name }) => name.trim().toLowerCase());
  if (names.some((name) => !name)) return BLANK_NAME;
  return new Set(names).size < names.length ? DUPLICATE_NAME : null;
}

// Edit in Kitchen settings: a Draft while editing, null while read-only. A conflict discards the
// Draft, since the newer list shows instead and nothing is merged; any other failure keeps it.
// `refreshed` says whether the Collection reloaded after the write.
type CategoriesState = { draft: Draft | null; problem?: string; notice?: string };

export type CategoriesAction =
  | { type: "open"; settings: KitchenSettings }
  | { type: "change"; key: string; name: string }
  | { type: "move"; key: string; by: -1 | 1 }
  | { type: "place"; key: string; index: number }
  | { type: "delete"; key: string; moveTo?: string }
  | { type: "add" }
  | { type: "cancel" }
  | { type: "problem"; problem: string }
  | { type: "settled"; outcome: BatchOutcome; refreshed: boolean };

function placed(draft: Draft, key: string, index: number): Draft {
  const { categories } = draft;
  const category = categories.find((c) => c.key === key);
  if (!category || category.added) return draft;
  const others = categories.filter((c) => c !== category);
  others.splice(Math.min(index, savedIn(draft).length - 1), 0, category);
  return { ...draft, categories: others };
}

function deleted(draft: Draft, key: string, moveTo: string | undefined): Draft {
  const { categories, deletes } = draft;
  const category = categories.find((c) => c.key === key);
  const left = categories.filter((c) => c !== category);
  if (category?.added) return { ...draft, categories: left };
  if (!moveTo || !moveTargets(draft, key).some((c) => c.key === moveTo)) return draft;
  return { ...draft, categories: left, deletes: [...deletes, { id: key, moveTo }] };
}

function edited(draft: Draft, action: CategoriesAction): Draft {
  const { categories, addedSoFar } = draft;
  switch (action.type) {
    case "change":
      return {
        ...draft,
        categories: categories.map((c) => (c.key === action.key ? { ...c, name: action.name } : c)),
      };
    case "move": {
      const index = categories.findIndex((c) => c.key === action.key);
      return canMove(draft, index, action.by)
        ? placed(draft, action.key, index + action.by)
        : draft;
    }
    case "place":
      return placed(draft, action.key, action.index);
    case "delete":
      return deleted(draft, action.key, action.moveTo);
    case "add":
      return {
        ...draft,
        categories: [...categories, { key: `added-${addedSoFar}`, name: "", added: true }],
        addedSoFar: addedSoFar + 1,
      };
    default:
      return draft;
  }
}

export function editingCategories(
  state: CategoriesState,
  action: CategoriesAction,
): CategoriesState {
  switch (action.type) {
    case "open":
      return { draft: draftOf(action.settings) };
    case "cancel":
      return { draft: null };
    case "problem":
      return { ...state, problem: action.problem };
    case "settled":
      switch (action.outcome.kind) {
        case "saved":
          return action.refreshed ? { draft: null } : { draft: null, notice: SAVED_NOT_REFRESHED };
        case "conflict":
          return {
            draft: null,
            notice: action.refreshed ? CHANGED_ELSEWHERE : CHANGED_NOT_REFRESHED,
          };
        case "invalid":
          return { ...state, problem: action.outcome.message };
        case "not-an-editor":
          return { ...state, problem: NOT_AN_EDITOR };
        default:
          return { ...state, problem: UNREACHABLE };
      }
    default:
      return state.draft ? { ...state, draft: edited(state.draft, action) } : state;
  }
}

// What a Pantry Staple toggle's write has to say, if anything. It saves at once and alone, so no
// answer here touches a Draft.
export function stapleNotice(
  outcome: { kind: "saved" } | WriteRefusal,
  refreshed: boolean,
): string | null {
  switch (outcome.kind) {
    case "saved":
      return refreshed ? null : SAVED_NOT_REFRESHED;
    case "conflict":
      return refreshed ? CHANGED_ELSEWHERE : CHANGED_NOT_REFRESHED;
    case "not-an-editor":
      return NOT_AN_EDITOR;
    default:
      return UNREACHABLE;
  }
}
