import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AS_WRITTEN } from "./adjust";
import type { Recipe } from "./api/client";
import { effective, lineNote, stepNote } from "./ourVersion";
import { recipe as awaitingReview, parse } from "./review.fixtures";
import { stepText } from "./stepText";

const editors = (name: string, quantity: number, unit: string | null) => ({
  ...parse(name, true, unit),
  provenance: "editor" as const,
  quantity: { low: quantity, high: quantity },
});

const facts = (name: string, quantity: number, unit: string | null) => ({
  parse: editors(name, quantity, unit),
  match: null,
  conversion: null,
  substitutions: null,
});

// The synthetic beans with an Our Version: i1 at 1 tbsp, i2 renamed, i3 removed, two lines added
// in a chain after i1 and one first, s1 removed, s2 edited and a step added first.
const ours = (fields: Partial<NonNullable<Recipe["our_version"]>> = {}): Recipe =>
  awaitingReview({
    our_version: {
      ingredients: {
        edit: {
          i1: { text: "1 tbsp butter", component: null },
          i2: { text: "2 cloves shallot", component: null },
        },
        remove: ["i3"],
        add: [
          { id: "i6", after: "i5", text: "1 lemon", component: null },
          { id: "i5", after: "i1", text: "2 cups beans", component: null },
          { id: "i7", after: null, text: "1 onion", component: null },
        ],
      },
      steps: {
        edit: { s2: { text: "Serve hot.", component: null } },
        remove: [],
        add: [{ id: "s3", after: null, text: "Soak the beans.", component: null }],
      },
      facts: {
        ingredients: {
          i1: facts("butter", 1, "tbsp"),
          i2: facts("shallot", 2, "cloves"),
          i5: facts("beans", 2, "cups"),
          i6: facts("lemon", 1, null),
          i7: facts("onion", 1, null),
        },
        steps: {},
        difficulty: null,
      },
      note: "More beans, less butter.",
      edited_at: "2026-11-02T00:00:00Z",
      ...fields,
    },
  });

const ids = (items: { id: string }[]) => items.map((item) => item.id);

describe("effective", () => {
  it("leaves out removed lines and puts added ones after the line they name, chains in order", () => {
    const { original } = effective(ours(), "ours");
    expect(ids(original.ingredients)).toEqual(["i7", "i1", "i5", "i6", "i2", "i4"]);
    expect(ids(original.steps)).toEqual(["s3", "s1", "s2"]);
  });

  it("gives an Our Version line its own facts and an unchanged line the Original's", () => {
    const recipe = ours();
    const { original, facts } = effective(recipe, "ours");
    expect(original.ingredients.find((l) => l.id === "i1")?.text).toBe("1 tbsp butter");
    expect(facts.ingredients.i1?.parse?.quantity).toEqual({ low: 1, high: 1 });
    expect(facts.ingredients.i5?.parse?.name).toBe("beans");
    expect(facts.ingredients.i4).toBe(recipe.facts.ingredients.i4);
    const confirmed = effective(ours({ ingredients: { edit: {}, remove: [], add: [] } }), "ours");
    expect(confirmed.facts.ingredients.i2).toEqual(recipe.facts.ingredients.i2);
    expect(facts.ingredients.i3).toBeUndefined();
  });

  it("marks edited and added lines and steps, keeping the replaced line and its facts", () => {
    const recipe = ours();
    const { original } = effective(recipe, "ours");
    const line = (id: string) => original.ingredients.find((l) => l.id === id);
    expect(line("i1")?.change).toEqual({
      kind: "edited",
      was: recipe.original.ingredients[0],
      wasFacts: recipe.facts.ingredients.i1,
    });
    expect(line("i5")?.change).toEqual({ kind: "added" });
    expect(line("i4")?.change).toBeUndefined();
    expect(original.steps.map((s) => s.change)).toEqual(["added", undefined, "edited"]);
  });

  it("shows an Our Version step's raw text, as it waits for enrich", () => {
    const recipe = ours({
      steps: { edit: { s1: { text: "Brown the butter.", component: null } }, remove: [], add: [] },
    });
    const { original, facts } = effective(recipe, "ours");
    const s1 = original.steps.find((s) => s.id === "s1");
    expect(s1 && stepText(s1, facts, AS_WRITTEN)).toEqual(["Brown the butter."]);
  });

  it("shows a segment for a removed line as its words, with no amount", () => {
    const recipe = ours({
      ingredients: { edit: {}, remove: ["i1"], add: [] },
      steps: { edit: {}, remove: [], add: [] },
    });
    const { original, facts } = effective(recipe, "ours");
    const s1 = original.steps.find((s) => s.id === "s1");
    expect(s1 && stepText(s1, facts, AS_WRITTEN)).toEqual(["Melt ", "the butter", "."]);
  });

  it("scales an unchanged step's segment by the edited line's amount", () => {
    const { original, facts } = effective(ours(), "ours");
    const s1 = original.steps.find((s) => s.id === "s1");
    expect(s1 && stepText(s1, facts, AS_WRITTEN)).toEqual([
      "Melt ",
      { amount: "1 tbsp", name: "butter" },
      ".",
    ]);
  });

  it("is the Original, unmarked, for the Original choice or a recipe without Our Version", () => {
    const recipe = ours();
    expect(effective(recipe, "original")).toEqual({
      original: recipe.original,
      facts: recipe.facts,
    });
    const plain = awaitingReview();
    expect(effective(plain, "ours")).toEqual({ original: plain.original, facts: plain.facts });
  });
});

// Cases the API's test_our_version_review.py checks too, so the two effective recipes can't drift.
type SharedCase = {
  name: string;
  recipe: Pick<Recipe, "facts" | "our_version"> & {
    original: Pick<Recipe["original"], "ingredients" | "steps">;
  };
  expected: { ingredients: object[]; steps: object[]; facts: object };
};
const shared: { cases: SharedCase[] } = JSON.parse(
  readFileSync(
    new URL("../../backend/tests/fixtures/effective_lines.json", import.meta.url),
    "utf8",
  ),
);

describe.each(shared.cases)("the shared effective case: $name", ({ recipe, expected }) => {
  it("shows the lines, steps and facts the API does", () => {
    const given = { ...recipe, original: { ...awaitingReview().original, ...recipe.original } };
    const { original, facts } = effective(given, "ours");
    // The API marks a line's change by its kind alone, and keeps no Difficulty beside the facts.
    const lines = original.ingredients.map(({ change, ...line }) =>
      change ? { ...line, change: change.kind } : line,
    );
    const { difficulty: _, ...stepsAndLines } = facts;
    expect({ ingredients: lines, steps: original.steps, facts: stepsAndLines }).toEqual(expected);
  });
});

describe("lineNote", () => {
  const shown = (recipe: Recipe, id: string, choices = AS_WRITTEN) => {
    const { original, facts } = effective(recipe, "ours");
    const line = original.ingredients.find((l) => l.id === id);
    return line && lineNote(line, facts.ingredients[id], choices);
  };

  it("says only the amount it was when only the amount or unit changed", () => {
    expect(shown(ours(), "i1")).toBe("was 2 tbsp");
  });

  it("follows the Adjust scale, so it compares like with like", () => {
    expect(shown(ours(), "i1", { scale: 2, units: "written" })).toBe("was ¼ cup");
  });

  it("says the whole replaced line when more than the amount changed", () => {
    expect(shown(ours(), "i2")).toBe("was 2 cloves garlic");
  });

  it("says the whole replaced line when it had no parse", () => {
    const recipe = ours({
      ingredients: { edit: { i4: { text: "1 tsp salt", component: null } }, remove: [], add: [] },
      facts: { ingredients: { i4: facts("salt", 1, "tsp") }, steps: {}, difficulty: null },
    });
    expect(shown(recipe, "i4")).toBe("was salt");
  });

  it("says an added line was added, and nothing for an unchanged one", () => {
    expect(shown(ours(), "i5")).toBe("added in Our Version");
    expect(shown(ours(), "i4")).toBeUndefined();
  });
});

describe("stepNote", () => {
  it("says an edited step changed and an added one was added", () => {
    const { original } = effective(ours(), "ours");
    expect(original.steps.map(stepNote)).toEqual([
      "added in Our Version",
      undefined,
      "changed in Our Version",
    ]);
  });
});
