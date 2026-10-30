import { describe, expect, it } from "vitest";
import type { Recipe } from "./api/client";
import {
  CHANGED_ELSEWHERE,
  changeCount,
  type Draft,
  deleteOutcome,
  draftOf,
  draftOperations,
  editing,
  editOutcome,
  RATE_ALL,
  saveLabel,
} from "./editRecipe";

const recipe = (fields: Partial<Recipe> = {}): Recipe =>
  ({
    id: "01K7TEST000000000000000001",
    version: 3,
    difficulty: { prep: 1, cook: 2, cleanup: 3 },
    tags: ["weeknight", "rice"],
    images: [{ id: "img1", width: 800, height: 600 }],
    preview: { image_id: "img1", focal_x: 0.5, focal_y: 0.5 },
    ...fields,
  }) as Recipe;

const edited = (r: Recipe, change: Partial<Draft>): Draft => ({ ...draftOf(r), ...change });
const response = (status: number) => new Response(null, { status });

describe("draftOf", () => {
  it("starts from the recipe as it is, Tags as one comma-separated line", () => {
    expect(draftOf(recipe())).toEqual({
      difficulty: { prep: 1, cook: 2, cleanup: 3 },
      tags: "weeknight, rice",
      preview: { image_id: "img1", focal_x: 0.5, focal_y: 0.5 },
    });
    expect(draftOf(recipe({ difficulty: null, tags: [], preview: null }))).toEqual({
      difficulty: {},
      tags: "",
      preview: null,
    });
  });
});

describe("changeCount and draftOperations", () => {
  it("count nothing and send nothing for an untouched draft", () => {
    const r = recipe();
    expect(changeCount(r, draftOf(r))).toBe(0);
    expect(draftOperations(r, draftOf(r))).toEqual([]);
  });

  it("ignore retyped Tags that parse to the same list", () => {
    const r = recipe();
    const draft = edited(r, { tags: " weeknight ,rice, , Rice" });
    expect(changeCount(r, draft)).toBe(0);
    expect(draftOperations(r, draft)).toEqual([]);
  });

  it("send only what changed", () => {
    const r = recipe();
    const draft = edited(r, {
      tags: "weeknight, rice, quick",
      difficulty: { prep: 2, cook: 2, cleanup: 3 },
    });
    expect(changeCount(r, draft)).toBe(2);
    expect(draftOperations(r, draft)).toEqual([
      { op: "set_difficulty", difficulty: { prep: 2, cook: 2, cleanup: 3 } },
      { op: "set_tags", tags: ["weeknight", "rice", "quick"] },
    ]);
  });

  it("send a cleared Difficulty, no Tags and No photo as such", () => {
    const r = recipe();
    const draft = edited(r, { difficulty: {}, tags: "", preview: null });
    expect(changeCount(r, draft)).toBe(3);
    expect(draftOperations(r, draft)).toEqual([
      { op: "set_difficulty", difficulty: null },
      { op: "set_tags", tags: [] },
      { op: "set_preview", preview: null },
    ]);
  });

  it("count a moved Focal Point as a change to the Preview Photo", () => {
    const r = recipe();
    const preview = { image_id: "img1", focal_x: 0.3, focal_y: 0.5 };
    const draft = edited(r, { preview });
    expect(changeCount(r, draft)).toBe(1);
    expect(draftOperations(r, draft)).toEqual([{ op: "set_preview", preview }]);
  });

  it("count a part-rated Difficulty as a change, but send nothing until it's whole", () => {
    const r = recipe({ difficulty: null });
    const draft = edited(r, { difficulty: { prep: 2 } });
    expect(changeCount(r, draft)).toBe(1);
    expect(draftOperations(r, draft)).toBeUndefined();
  });
});

describe("saveLabel", () => {
  it("names how many changes Save sends", () => {
    expect(saveLabel(0)).toBe("Save 0 changes");
    expect(saveLabel(1)).toBe("Save 1 change");
    expect(saveLabel(3)).toBe("Save 3 changes");
  });
});

describe("editOutcome and deleteOutcome", () => {
  it("are the saved recipe on a 200, and deleted on a 204", () => {
    const saved = recipe({ version: 4 });
    expect(editOutcome({ data: saved, response: response(200) })).toEqual({
      kind: "saved",
      recipe: saved,
    });
    expect(deleteOutcome({ response: response(204) })).toEqual({ kind: "deleted" });
  });

  it("are a conflict on a 409 for a stale version", () => {
    const stale = { detail: "Version conflict: reload and try again" };
    expect(editOutcome({ error: stale, response: response(409) })).toEqual({ kind: "conflict" });
    expect(deleteOutcome({ error: stale, response: response(409) })).toEqual({
      kind: "conflict",
    });
  });

  it("tell a signed-out editor from a failure", () => {
    const forbidden = { detail: "Editors only" };
    expect(editOutcome({ error: forbidden, response: response(403) })).toEqual({
      kind: "not-an-editor",
    });
    expect(deleteOutcome({ response: response(503) })).toEqual({ kind: "failed" });
  });
});

describe("editing", () => {
  const r = recipe();
  const open = editing({ draft: null }, { type: "open", recipe: r });

  it("opens Edit with the recipe as the draft", () => {
    expect(open).toEqual({ draft: draftOf(r) });
  });

  it("keeps changes in the draft", () => {
    const changed = editing(open, { type: "change", change: { tags: "soup" } });
    expect(changed.draft).toEqual({ ...draftOf(r), tags: "soup" });
  });

  it("discards the draft on Cancel", () => {
    const changed = editing(open, { type: "change", change: { tags: "soup" } });
    expect(editing(changed, { type: "cancel" })).toEqual({ draft: null });
  });

  it("asks for a whole Difficulty, keeping the draft", () => {
    const partial = editing(open, { type: "change", change: { difficulty: { prep: 2 } } });
    expect(editing(partial, { type: "incomplete" })).toEqual({
      draft: partial.draft,
      problem: RATE_ALL,
    });
  });

  it("leaves Edit once saved", () => {
    expect(editing(open, { type: "settled", outcome: { kind: "saved", recipe: r } })).toEqual({
      draft: null,
    });
  });

  it("discards the draft on a conflict and says the newer version is showing", () => {
    const changed = editing(open, { type: "change", change: { tags: "soup" } });
    expect(editing(changed, { type: "settled", outcome: { kind: "conflict" } })).toEqual({
      draft: null,
      notice: CHANGED_ELSEWHERE,
    });
  });

  it("keeps the draft when the save failed, to try again", () => {
    const failed = editing(open, { type: "settled", outcome: { kind: "failed" } });
    expect(failed.draft).toEqual(open.draft);
    expect(failed.problem).toBe("Couldn’t reach Plateful. Try again.");
  });

  it("clears an old notice when Edit opens again", () => {
    const conflicted = editing(open, { type: "settled", outcome: { kind: "conflict" } });
    expect(editing(conflicted, { type: "open", recipe: r })).toEqual({ draft: draftOf(r) });
  });
});
