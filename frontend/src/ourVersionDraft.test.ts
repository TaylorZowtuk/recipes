import { describe, expect, it } from "vitest";
import type { Recipe } from "./api/client";
import { type LineEdit, lineDraft, lineOf } from "./factEdits";
import {
  addLine,
  addStep,
  editLine,
  editStep,
  lineFor,
  ourDraftOf,
  ourOperation,
  ourRows,
  removeItem,
  restoreItem,
} from "./ourVersionDraft";
import { GARLIC, KNOWN_CANONICAL, parse, recipe } from "./review.fixtures";

const edit = (name: string, low = 1): LineEdit => ({
  kind: "line",
  line_id: "ignored",
  quantity: { low, high: low },
  unit: "tbsp",
  name,
  preparation: null,
  fdc_id: GARLIC.fdcId,
  portion_id: null,
  canonical: { kind: "existing", id: KNOWN_CANONICAL },
});

const form = lineDraft({ id: "new", text: "" });

// The synthetic beans with an Our Version that edits i1 and adds i5 after it.
const withOurs = (): Recipe =>
  recipe({
    our_version: {
      ingredients: {
        edit: { i1: { text: "1 tbsp butter", component: null } },
        remove: [],
        add: [{ id: "i5", after: "i1", text: "2 tbsp beans", component: null }],
      },
      steps: { edit: {}, remove: [], add: [] },
      facts: {
        ingredients: {
          i1: {
            parse: { ...parse("butter", true, "tbsp"), quantity: { low: 1, high: 1 } },
            match: null,
            conversion: null,
            substitutions: null,
          },
          i5: { parse: parse("beans", true, "tbsp"), match: null, conversion: null, substitutions: null },
        },
        steps: {},
        difficulty: null,
      },
      note: "Less butter.",
      edited_at: "2026-11-02T00:00:00Z",
      last_line: 5,
      last_step: 0,
    },
  });

const saved = (r: Recipe, draft: ReturnType<typeof ourDraftOf>) => {
  const operation = ourOperation(r, draft);
  if (operation?.op !== "set_our_version") throw new Error(`no set_our_version: ${operation}`);
  return operation.our_version;
};

describe("the Our Version draft", () => {
  it("is no operation while unchanged, with or without a stored Our Version", () => {
    expect(ourOperation(recipe(), ourDraftOf(recipe()))).toBeUndefined();
    expect(ourOperation(withOurs(), ourDraftOf(withOurs()))).toBeUndefined();
    // A stored line saved again from its own form is unchanged too.
    const r = withOurs();
    const { canonical: _, ...asStored } = { ...edit("butter"), fdc_id: null };
    const again = editLine(r, ourDraftOf(r), "i1", asStored, form);
    expect(ourOperation(r, again)).toBeUndefined();
  });

  it("names a new line by a draft id that a later new line's `after` follows", () => {
    const r = recipe();
    const one = addLine(ourDraftOf(r), { after: "i2", component: null }, edit("lemon"), form);
    const first = one.ingredients.add[0]?.id ?? "";
    const two = addLine(one, { after: first, component: null }, edit("lime"), form);
    const { add } = saved(r, two).ingredients;
    expect(add.map((a) => [a.id, a.after, a.name])).toEqual([
      [first, "i2", "lemon"],
      [expect.any(String), first, "lime"],
    ]);
    expect(add[1]?.id).not.toBe(first);
    expect(["i1", "i2", "i3", "i4"]).not.toContain(first);
    expect(ourRows(r, two).ingredients.map((row) => row.id)).toEqual([
      "i1",
      "i2",
      first,
      add[1]?.id,
      "i3",
      "i4",
    ]);
  });

  it("sends an edited line's component, so it keeps its heading", () => {
    const base = recipe();
    const r = recipe({
      original: {
        ...base.original,
        ingredients: base.original.ingredients.map((l) => ({ ...l, component: "For the sauce" })),
      },
    });
    const draft = editLine(r, ourDraftOf(r), "i1", edit("butter", 3), form);
    expect(saved(r, draft).ingredients.edit.i1).toMatchObject({
      component: "For the sauce",
      quantity: { low: 3, high: 3 },
      name: "butter",
    });
  });

  it("is no operation once an Original line removed is restored", () => {
    const r = recipe();
    const removed = removeItem(ourDraftOf(r), "ingredients", "i3");
    expect(saved(r, removed).ingredients.remove).toEqual(["i3"]);
    expect(ourRows(r, removed).ingredients.find((row) => row.id === "i3")?.change).toBe("removed");
    expect(ourOperation(r, restoreItem(removed, "ingredients", "i3"))).toBeUndefined();
  });

  it("restores an edited Original line to the Original, and drops a removed added one", () => {
    const r = withOurs();
    const draft = removeItem(restoreItem(ourDraftOf(r), "ingredients", "i1"), "ingredients", "i5");
    const ours = saved(r, draft).ingredients;
    expect(ours.edit).toEqual({});
    expect(ours.add).toEqual([]);
  });

  it("moves a line added after a removed line to the line before it", () => {
    const r = recipe();
    const added = addLine(ourDraftOf(r), { after: "i2", component: null }, edit("lemon"), form);
    const draft = removeItem(added, "ingredients", "i2");
    expect(saved(r, draft).ingredients.add[0]?.after).toBe("i1");
  });

  it("edits, adds and removes steps by their text, an unchanged text being no edit", () => {
    const r = recipe();
    expect(ourOperation(r, editStep(r, ourDraftOf(r), "s1", "Melt the butter."))).toBeUndefined();
    const draft = addStep(
      editStep(r, ourDraftOf(r), "s1", "Brown the butter."),
      {
        after: "s2",
        component: null,
      },
      "Eat.",
    );
    const { steps } = saved(r, draft);
    expect(steps.edit).toEqual({ s1: { text: "Brown the butter.", component: null } });
    expect(steps.add).toMatchObject([{ after: "s2", text: "Eat.", component: null }]);
  });

  it("sends the note trimmed, and none for an empty one", () => {
    const r = withOurs();
    expect(saved(r, { ...ourDraftOf(r), note: "  Less salt. " }).note).toBe("Less salt.");
    expect(saved(r, { ...ourDraftOf(r), note: " " }).note).toBeNull();
  });

  it("removes a stored Our Version, and does nothing to remove when there's none", () => {
    expect(ourOperation(withOurs(), { ...ourDraftOf(withOurs()), removed: true })).toEqual({
      op: "remove_our_version",
    });
    expect(ourOperation(recipe(), { ...ourDraftOf(recipe()), removed: true })).toBeUndefined();
  });

  it("gives a line's edit form Our Version's facts, the Original's, or none for a new line", () => {
    const r = withOurs();
    expect(lineFor(r, "i1").facts?.parse?.quantity).toEqual({ low: 1, high: 1 });
    expect(lineFor(r, "i5").facts?.parse?.name).toBe("beans");
    expect(lineFor(r, "i2")).toEqual(lineOf(r, "i2"));
    expect(lineFor(r, "new-1")).toEqual({ id: "new-1", text: "" });
  });
});
