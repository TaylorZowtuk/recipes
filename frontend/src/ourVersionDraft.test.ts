import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Recipe } from "./api/client";
import { EDITOR_KEPT, type LineEdit, lineDraft, lineEdit, lineOf } from "./factEdits";
import {
  addLine,
  addStep,
  editLine,
  editStep,
  lineFor,
  lineText,
  type OurDraft,
  ourDraftOf,
  ourOperation,
  ourRows,
  removeItem,
  restoreItem,
} from "./ourVersionDraft";
import { conversion, GARLIC, KNOWN_CANONICAL, match, parse, recipe } from "./review.fixtures";

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

// The synthetic beans with an Our Version that edits i1, matched and kept in tablespoons, and
// adds i5 after it.
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
            match: match(KNOWN_CANONICAL, true),
            conversion: conversion(true, { density_g_per_ml: 0.96, refused: EDITOR_KEPT }),
            substitutions: null,
          },
          i5: {
            parse: parse("beans", true, "tbsp"),
            match: null,
            conversion: null,
            substitutions: null,
          },
        },
        steps: {},
        difficulty: null,
      },
      note: "Less butter.",
      edited_at: "2026-11-02T00:00:00Z",
    },
  });

// The draft with the line saved from its edit form, opened as stored and changed by `change`.
const fromForm = (r: Recipe, id: string, change: Partial<ReturnType<typeof lineDraft>> = {}) => {
  const line = lineFor(r, id);
  const draft = { ...lineDraft(line), ...change };
  const built = lineEdit(line, draft);
  if (!("edit" in built)) throw new Error(built.problem);
  return editLine(r, ourDraftOf(r), id, built.edit, draft);
};

const saved = (r: Recipe, draft: ReturnType<typeof ourDraftOf>) => {
  const operation = ourOperation(r, draft);
  if (operation?.op !== "set_our_version") throw new Error(`no set_our_version: ${operation}`);
  return operation.our_version;
};

describe("the Our Version draft", () => {
  it("is no operation while unchanged, with or without a stored Our Version", () => {
    expect(ourOperation(recipe(), ourDraftOf(recipe()))).toBeUndefined();
    expect(ourOperation(withOurs(), ourDraftOf(withOurs()))).toBeUndefined();
    // A stored line saved again from its own form is unchanged too: its food and kept weight.
    const r = withOurs();
    expect(ourOperation(r, fromForm(r, "i1"))).toBeUndefined();
  });

  it("sends a stored line whose weight is now converted", () => {
    const r = withOurs();
    const converted = fromForm(r, "i1", { keepWeight: false });
    expect(saved(r, converted).ingredients.edit.i1?.keep_weight).toBe(false);
  });

  it("is no operation with the same lines removed in another order", () => {
    const base = withOurs();
    const ours = base.our_version as NonNullable<Recipe["our_version"]>;
    const r = {
      ...base,
      our_version: { ...ours, ingredients: { ...ours.ingredients, remove: ["i2", "i3"] } },
    };
    let draft = ourDraftOf(r);
    for (const id of ["i2", "i3"]) draft = restoreItem(draft, "ingredients", id);
    for (const id of ["i3", "i2"]) draft = removeItem(draft, "ingredients", id);
    expect(draft.ingredients.remove).toEqual(["i3", "i2"]);
    expect(ourOperation(r, draft)).toBeUndefined();
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

describe("a stored Our Version changed in one thing alone", () => {
  // The stored Our Version, which also edits step s1, drafted and then changed by `change`.
  const changed = (change: (draft: OurDraft) => void) => {
    const base = withOurs();
    const ours = base.our_version as NonNullable<Recipe["our_version"]>;
    const s1 = { text: "Brown the butter.", component: null };
    const r = { ...base, our_version: { ...ours, steps: { ...ours.steps, edit: { s1 } } } };
    const draft = structuredClone(ourDraftOf(r));
    expect(ourOperation(r, draft)).toBeUndefined();
    change(draft);
    return ourOperation(r, draft);
  };
  const i1 = (draft: OurDraft) =>
    draft.ingredients.edit.i1 as NonNullable<OurDraft["ingredients"]["edit"]["i1"]>;
  const i5 = (draft: OurDraft) =>
    draft.ingredients.add[0] as NonNullable<OurDraft["ingredients"]["add"][0]>;

  it.each<[string, (draft: OurDraft) => void]>([
    ["a line's food", (d) => (i1(d).fdc_id = 99999)],
    ["a line's portion", (d) => (i1(d).portion_id = 7)],
    ["a line's Canonical Ingredient", (d) => (i1(d).canonical = { kind: "existing", id: "c9" })],
    ["a line's component", (d) => (i1(d).component = "For the glaze")],
    ["an added line's place", (d) => (i5(d).after = "i2")],
    ["an added line's id", (d) => (i5(d).id = "i6")],
    [
      "a step's component",
      (d) => ((d.steps.edit.s1 as { component: string | null }).component = "To serve"),
    ],
  ])("is sent for %s", (_, change) => {
    expect(changed(change)?.op).toBe("set_our_version");
  });

  it("is sent once a stored edited line is restored, and nothing else changes", () => {
    const operation = changed((d) => {
      d.ingredients = restoreItem(d, "ingredients", "i1").ingredients;
    });
    expect(operation?.op === "set_our_version" && operation.our_version.ingredients.edit).toEqual(
      {},
    );
  });
});

// Cases the API's line_text checks too, so an edited line reads the same in Edit as once saved.
const lineTexts: {
  cases: { name: string; parse: Parameters<typeof lineText>[0]; text: string }[];
} = JSON.parse(
  readFileSync(new URL("../../backend/tests/fixtures/line_text.json", import.meta.url), "utf8"),
);

describe.each(lineTexts.cases)("the shared line text case: $name", (c) => {
  it("reads as the API builds it", () => expect(lineText(c.parse)).toBe(c.text));
});

describe("an edited line's row", () => {
  it("keeps the comment of the line it replaces", () => {
    const r = recipe();
    const i1 = r.facts.ingredients.i1;
    if (i1) i1.parse = { ...parse("butter"), comment: "or to taste" };
    const draft = editLine(r, ourDraftOf(r), "i1", edit("butter", 3), form);
    expect(ourRows(r, draft).ingredients[0]?.text).toBe("3 tbsp butter, or to taste");
  });
});
