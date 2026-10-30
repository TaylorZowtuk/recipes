import { describe, expect, it } from "vitest";
import type { ParseFact, RecipeFacts, Step, StepFacts } from "./api/client";
import { stepText } from "./stepText";

type Segment = NonNullable<StepFacts["segments"]>["segments"][number];

const step: Step = { id: "s1", component: null, text: "Add half the garlic and simmer." };

const fact = { provenance: "llm", confidence: 0.8, estimated: false } as const;
const confirmation = {
  confirmed: false,
  confirmed_by: null,
  confirmed_at: null,
  confirm_batch: null,
};

// A step's facts from its segments (a string is a text segment) and its uses, ref to portion.
function stepFacts(segments: (string | Segment)[] | null, uses: Record<string, number>): StepFacts {
  return {
    segments: segments && {
      ...fact,
      ...confirmation,
      segments: segments.map((s) => (typeof s === "string" ? { t: "text", v: s } : s)),
    },
    uses: {
      ...fact,
      ...confirmation,
      uses: Object.entries(uses).map(([ref, portion]) => ({ ref, portion })),
    },
  };
}

const parse = (fact: Partial<ParseFact>): ParseFact => ({
  quantity: null,
  unit: null,
  unit_kind: null,
  name: "ingredient",
  short_name: null,
  preparation: null,
  comment: null,
  optional: false,
  provenance: "parser",
  confidence: 0.9,
  estimated: false,
  confirmed: false,
  confirmed_by: null,
  confirmed_at: null,
  confirm_batch: null,
  ...fact,
});

const garlic = parse({ quantity: { low: 4, high: 4 }, unit: "cloves", name: "garlic" });

function facts(ingredients: Record<string, ParseFact | null>, s1?: StepFacts): RecipeFacts {
  return {
    ingredients: Object.fromEntries(
      Object.entries(ingredients).map(([ref, p]) => [
        ref,
        { parse: p, match: null, conversion: null },
      ]),
    ),
    steps: s1 ? { s1 } : {},
  };
}

const halfTheGarlic = (uses: Record<string, number>) =>
  stepFacts(
    ["Add ", { t: "ingredient", ref: "i1", written: "half the garlic" }, " and simmer."],
    uses,
  );

describe("stepText", () => {
  it("shows the step's portion of the line's amount in place of the words", () => {
    expect(stepText(step, facts({ i1: garlic }, halfTheGarlic({ i1: 0.5 })), 1)).toEqual([
      "Add ",
      { amount: "2 cloves", name: "garlic" },
      " and simmer.",
    ]);
  });

  it("scales the portion", () => {
    expect(stepText(step, facts({ i1: garlic }, halfTheGarlic({ i1: 0.5 })), 3)).toEqual([
      "Add ",
      { amount: "6 cloves", name: "garlic" },
      " and simmer.",
    ]);
  });

  it("scales both ends of a range, in kitchen fractions", () => {
    const onions = parse({ quantity: { low: 1, high: 2 }, name: "green onions" });
    expect(stepText(step, facts({ i1: onions }, halfTheGarlic({ i1: 0.5 })), 1)[1]).toEqual({
      amount: "½–1",
      name: "green onions",
    });
    const vinegar = parse({ quantity: { low: 1.5, high: 1.5 }, unit: "tbsp", name: "vinegar" });
    expect(stepText(step, facts({ i1: vinegar }, halfTheGarlic({ i1: 0.5 })), 1)[1]).toEqual({
      amount: "¾ tbsp",
      name: "vinegar",
    });
  });

  it("prefers the line's short name", () => {
    const tofu = parse({
      quantity: { low: 400, high: 400 },
      unit: "g",
      name: "extra-firm tofu",
      short_name: "tofu",
    });
    expect(stepText(step, facts({ i1: tofu }, halfTheGarlic({ i1: 1 })), 1)[1]).toEqual({
      amount: "400 g",
      name: "tofu",
    });
  });

  it("takes all of a line the step names but has no use for", () => {
    expect(stepText(step, facts({ i1: garlic }, halfTheGarlic({})), 1)[1]).toEqual({
      amount: "4 cloves",
      name: "garlic",
    });
  });

  it("keeps the words as written when the line has no amount or no parse", () => {
    const salt = parse({ name: "salt" });
    expect(stepText(step, facts({ i1: salt }, halfTheGarlic({ i1: 1 })), 1)[1]).toBe(
      "half the garlic",
    );
    expect(stepText(step, facts({ i1: null }, halfTheGarlic({ i1: 1 })), 1)[1]).toBe(
      "half the garlic",
    );
    expect(stepText(step, facts({}, halfTheGarlic({ i1: 1 })), 1)[1]).toBe("half the garlic");
  });

  it("keeps durations and temperatures as written", () => {
    const roast = stepFacts(
      [
        "Roast ",
        { t: "duration", low_s: 4200, high_s: 4800, written: "70-80 minutes" },
        " at ",
        { t: "temperature", c: 218, written: "425°F" },
        ".",
      ],
      {},
    );
    expect(stepText(step, facts({}, roast), 1)).toEqual([
      "Roast ",
      "70-80 minutes",
      " at ",
      "425°F",
      ".",
    ]);
  });

  it("shows the raw text of a step with no segments", () => {
    expect(stepText(step, facts({ i1: garlic }, stepFacts(null, { i1: 1 })), 1)).toEqual([
      step.text,
    ]);
    expect(stepText(step, facts({ i1: garlic }), 1)).toEqual([step.text]);
    expect(stepText(step, undefined, 1)).toEqual([step.text]);
  });
});
