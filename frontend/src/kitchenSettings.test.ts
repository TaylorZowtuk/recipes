import { describe, expect, it } from "vitest";
import type { CanonicalIngredient, KitchenSettings } from "./api/client";
import {
  BLANK_NAME,
  type CategoriesAction,
  CHANGED_ELSEWHERE,
  CHANGED_NOT_REFRESHED,
  canDrag,
  canMove,
  changeCount,
  type Draft,
  DUPLICATE_NAME,
  draftOf,
  draftOperations,
  draftProblem,
  dragOffset,
  dropIndex,
  editingCategories,
  ingredientsMoving,
  moveTargets,
  stapleNotice,
} from "./kitchenSettings";

const SAVED: KitchenSettings = {
  version: 4,
  schema_version: 1,
  store_categories: [
    { id: "a", name: "Aisles" },
    { id: "b", name: "Bakery" },
    { id: "c", name: "Chilled" },
  ],
};

const ingredient = (id: string, store_category_id: string): CanonicalIngredient => ({
  id,
  name: id,
  family: id,
  store_category_id,
  confirmed: true,
  confirm_batch: null,
  pantry_staple: false,
  schema_version: 1,
  version: 1,
});

const from = (draft: Draft, ...actions: CategoriesAction[]) =>
  actions.reduce(editingCategories, { draft }).draft as Draft;
const draftAfter = (...actions: CategoriesAction[]) => from(draftOf(SAVED), ...actions);
const keys = (draft: Draft) => draft.categories.map((c) => c.key);
const rename = (key: string, name: string): CategoriesAction => ({ type: "change", key, name });
const add = (): CategoriesAction => ({ type: "add" });
const remove = (key: string, moveTo?: string): CategoriesAction => ({
  type: "delete",
  key,
  moveTo,
});
const move = (key: string, by: -1 | 1): CategoriesAction => ({ type: "move", key, by });
const place = (key: string, index: number): CategoriesAction => ({ type: "place", key, index });

describe("draftOperations", () => {
  it("sends nothing for an untouched Draft", () => {
    expect(draftOperations(draftAfter())).toEqual([]);
  });

  it("sends renames, then deletes, then one reorder of the saved survivors, then adds", () => {
    const draft = draftAfter(
      add(),
      rename("added-0", " Deli "),
      move("c", -1),
      remove("a", "c"),
      rename("b", " Breads "),
    );
    expect(draftOperations(draft)).toEqual([
      { op: "rename", id: "b", name: "Breads" },
      { op: "delete", id: "a", move_to: "c" },
      { op: "reorder", ids: ["c", "b"] },
      { op: "add", name: "Deli" },
    ]);
  });

  it("keeps deletes in the order they were made, so a chain's target is there when it's used", () => {
    expect(draftOperations(draftAfter(remove("a", "b"), remove("b", "c")))).toEqual([
      { op: "delete", id: "a", move_to: "b" },
      { op: "delete", id: "b", move_to: "c" },
    ]);
  });

  it("sends no rename for a category it deletes", () => {
    expect(draftOperations(draftAfter(rename("a", "New"), remove("a", "b")))).toEqual([
      { op: "delete", id: "a", move_to: "b" },
    ]);
  });

  it("sends no reorder when deleting leaves the rest in order", () => {
    expect(draftOperations(draftAfter(remove("b", "a"))).map((op) => op.op)).toEqual(["delete"]);
  });

  it("names only the survivors in a reorder, never an added category", () => {
    const draft = draftAfter(add(), rename("added-0", "Deli"), move("b", -1), remove("c", "a"));
    expect(draftOperations(draft).find((op) => op.op === "reorder")).toEqual({
      op: "reorder",
      ids: ["b", "a"],
    });
  });

  it("sends nothing for a category added then deleted", () => {
    expect(draftOperations(draftAfter(add(), remove("added-0")))).toEqual([]);
  });

  it("keeps added categories in the order they were added", () => {
    const draft = draftAfter(add(), add(), rename("added-0", "One"), rename("added-1", "Two"));
    expect(draftOperations(draft)).toEqual([
      { op: "add", name: "One" },
      { op: "add", name: "Two" },
    ]);
  });

  it("works from the list the Draft opened on, whatever has loaded since", () => {
    const draft = draftAfter(rename("a", "New"));
    expect(draft.base).toBe(SAVED);
    expect(draftOperations(draft)).toEqual([{ op: "rename", id: "a", name: "New" }]);
  });
});

describe("changeCount", () => {
  it("is one per operation, however many moves a reorder took", () => {
    expect(changeCount(draftAfter(move("a", 1), move("a", 1), rename("b", "New"), add()))).toBe(3);
  });

  it("drops a rename or a reorder put back", () => {
    expect(changeCount(draftAfter(rename("a", "New"), rename("a", " Aisles ")))).toBe(0);
    expect(changeCount(draftAfter(move("a", 1), move("a", -1)))).toBe(0);
  });
});

describe("moving", () => {
  it("swaps a category with its neighbour", () => {
    expect(keys(draftAfter(move("a", 1)))).toEqual(["b", "a", "c"]);
  });

  it("stops at the top and at the last saved category", () => {
    const draft = draftAfter(add());
    expect(canMove(draft, 0, -1)).toBe(false);
    expect(canMove(draft, 0, 1)).toBe(true);
    expect(canMove(draft, 2, 1)).toBe(false);
    expect(from(draft, move("c", 1))).toEqual(draft);
  });

  it("never moves an added category", () => {
    const draft = draftAfter(add());
    expect(canMove(draft, 3, -1)).toBe(false);
    expect(from(draft, move("added-0", -1))).toEqual(draft);
  });

  it("gives an added category a key of its own after another was deleted", () => {
    expect(keys(draftAfter(add(), remove("added-0"), add()))).toEqual(["a", "b", "c", "added-1"]);
  });
});

describe("dragging", () => {
  it("drops past each row it has half covered", () => {
    expect(dropIndex(0, 0, 100, 3)).toBe(0);
    expect(dropIndex(0, 40, 100, 3)).toBe(0);
    expect(dropIndex(0, 60, 100, 3)).toBe(1);
    expect(dropIndex(0, 160, 100, 3)).toBe(2);
    expect(dropIndex(2, -60, 100, 3)).toBe(1);
    expect(dropIndex(2, -160, 100, 3)).toBe(0);
  });

  it("stays within the rows it's given, however far it goes", () => {
    expect(dropIndex(1, 5000, 100, 3)).toBe(2);
    expect(dropIndex(1, -5000, 100, 3)).toBe(0);
  });

  it("slides the rows it passes by one row, and the dragged row with the pointer", () => {
    const drag = { from: 0, to: 2, dy: 210, stride: 100 };
    expect([0, 1, 2, 3].map((i) => dragOffset(drag, i))).toEqual([210, -100, -100, 0]);
    const up = { from: 2, to: 1, dy: -110, stride: 100 };
    expect([0, 1, 2].map((i) => dragOffset(up, i))).toEqual([0, 100, -110]);
  });

  it("places a saved category at the index it's dropped at", () => {
    expect(keys(draftAfter(place("a", 2)))).toEqual(["b", "c", "a"]);
    expect(keys(draftAfter(place("c", 0)))).toEqual(["c", "a", "b"]);
  });

  it("never places a saved category below an added one, nor drags an added one", () => {
    const draft = draftAfter(add());
    expect(keys(from(draft, place("a", 3)))).toEqual(["b", "c", "a", "added-0"]);
    expect(from(draft, place("added-0", 0))).toEqual(draft);
    expect(canDrag(draft, "a")).toBe(true);
    expect(canDrag(draft, "added-0")).toBe(false);
  });

  it("has nothing to drag a lone saved category past", () => {
    const draft = draftAfter(add(), remove("a", "b"), remove("b", "c"));
    expect(canDrag(draft, "c")).toBe(false);
  });
});

describe("deleting", () => {
  it("moves ingredients only into saved categories still in the Draft", () => {
    const draft = draftAfter(add(), remove("a", "b"));
    expect(moveTargets(draft, "b").map((c) => c.key)).toEqual(["c"]);
  });

  it("just removes a category added in this Draft", () => {
    const draft = draftAfter(add(), remove("added-0"));
    expect(keys(draft)).toEqual(["a", "b", "c"]);
    expect(draft.deletes).toEqual([]);
  });

  it("needs a target for a saved category", () => {
    expect(draftAfter(remove("a"))).toEqual(draftAfter());
  });

  it("refuses a target that's unsaved, already deleted or the category itself", () => {
    expect(keys(draftAfter(add(), remove("a", "added-0")))).toContain("a");
    expect(keys(draftAfter(remove("a", "b"), remove("c", "a")))).toContain("c");
    expect(keys(draftAfter(remove("a", "a")))).toContain("a");
  });

  it("has no target left for the last saved category, even beside added ones", () => {
    const draft = draftAfter(remove("a", "c"), remove("b", "c"), add());
    expect(moveTargets(draft, "c")).toEqual([]);
    expect(keys(from(draft, remove("c", "added-0")))).toEqual(["c", "added-0"]);
  });

  it("counts what will move, including what earlier deletes moved here", () => {
    const ingredients = [ingredient("x", "a"), ingredient("y", "a"), ingredient("z", "b")];
    expect(ingredientsMoving(ingredients, draftAfter(), "a")).toBe(2);
    expect(ingredientsMoving(ingredients, draftAfter(), "c")).toBe(0);
    expect(ingredientsMoving(ingredients, draftAfter(remove("a", "b")), "b")).toBe(3);
    expect(
      ingredientsMoving(ingredients, draftAfter(remove("a", "b"), remove("b", "c")), "c"),
    ).toBe(3);
  });
});

describe("draftProblem", () => {
  it("is nothing for names the API would take", () => {
    expect(draftProblem(draftAfter(rename("a", "New")))).toBeNull();
  });

  it("wants every category to have a name", () => {
    expect(draftProblem(draftAfter(rename("a", "  ")))).toBe(BLANK_NAME);
    expect(draftProblem(draftAfter(add()))).toBe(BLANK_NAME);
  });

  it("refuses two names that differ only in case or spaces", () => {
    expect(draftProblem(draftAfter(rename("a", " bakery ")))).toBe(DUPLICATE_NAME);
    expect(draftProblem(draftAfter(add(), rename("added-0", "CHILLED")))).toBe(DUPLICATE_NAME);
  });

  it("looks only at the names the save leaves, so a swap or a freed name is fine", () => {
    expect(draftProblem(draftAfter(rename("a", "Bakery"), rename("b", "Aisles")))).toBeNull();
    expect(draftProblem(draftAfter(remove("a", "b"), add(), rename("added-0", "Aisles")))).toBe(
      null,
    );
  });
});

describe("editingCategories", () => {
  const editing = () => ({ draft: draftAfter(rename("a", "New")) });
  const settled = (action: CategoriesAction) => editingCategories(editing(), action);
  const saved = (refreshed = true) =>
    settled({ type: "settled", outcome: { kind: "saved" }, refreshed });
  const conflict = (refreshed = true) =>
    settled({ type: "settled", outcome: { kind: "conflict" }, refreshed });

  it("opens from the saved list, dropping any old notice", () => {
    const state = editingCategories(
      { draft: null, notice: "Old" },
      { type: "open", settings: SAVED },
    );
    expect(state).toEqual({ draft: draftOf(SAVED) });
  });

  it("discards the Draft on Cancel", () => {
    expect(editingCategories(editing(), { type: "cancel" })).toEqual({ draft: null });
  });

  it("shows a problem found before saving, keeping the Draft", () => {
    const state = editingCategories(editing(), { type: "problem", problem: BLANK_NAME });
    expect(state.problem).toBe(BLANK_NAME);
    expect(state.draft).toEqual(editing().draft);
  });

  it("closes on a save, saying so when it couldn't refresh", () => {
    expect(saved()).toEqual({ draft: null });
    expect(saved(false).draft).toBeNull();
    expect(saved(false).notice).toMatch(/Saved, but couldn’t refresh/);
  });

  it("drops the Draft on a conflict and shows the notice", () => {
    expect(conflict()).toEqual({ draft: null, notice: CHANGED_ELSEWHERE });
    expect(conflict(false)).toEqual({ draft: null, notice: CHANGED_NOT_REFRESHED });
  });

  it("keeps the Draft and shows the API's message on a 422", () => {
    const state = settled({
      type: "settled",
      outcome: { kind: "invalid", message: "Two Store Categories have the same name" },
      refreshed: true,
    });
    expect(state.draft).toEqual(editing().draft);
    expect(state.problem).toBe("Two Store Categories have the same name");
  });

  it("keeps the Draft on any other failure", () => {
    const failed = settled({ type: "settled", outcome: { kind: "failed" }, refreshed: true });
    expect(failed.draft).toEqual(editing().draft);
    expect(failed.problem).toMatch(/Couldn’t reach/);
    const refused = settled({
      type: "settled",
      outcome: { kind: "not-an-editor" },
      refreshed: true,
    });
    expect(refused.problem).toMatch(/Sign in again/);
  });
});

describe("stapleNotice", () => {
  it("says nothing after a save that refreshed", () => {
    expect(stapleNotice({ kind: "saved" }, true)).toBeNull();
  });

  it("says when a save couldn't refresh", () => {
    expect(stapleNotice({ kind: "saved" }, false)).toMatch(/Saved, but couldn’t refresh/);
  });

  it("shows the newer version after a conflict", () => {
    expect(stapleNotice({ kind: "conflict" }, true)).toBe(CHANGED_ELSEWHERE);
    expect(stapleNotice({ kind: "conflict" }, false)).toBe(CHANGED_NOT_REFRESHED);
  });

  it("says why any other refusal failed", () => {
    expect(stapleNotice({ kind: "not-an-editor" }, true)).toMatch(/Sign in again/);
    expect(stapleNotice({ kind: "failed" }, true)).toMatch(/Couldn’t reach/);
  });
});
