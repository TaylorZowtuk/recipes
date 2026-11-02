import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Original, ParseFact } from "./api/client";
import { Ingredients, Steps } from "./RecipeScreen";

const original = (...lines: [string, string, string | null][]): Original => ({
  title: "Synthetic Test Noodles",
  description: null,
  author: null,
  extractor: "json-ld",
  ingredients: lines.map(([id, text, component]) => ({ id, text, component })),
  steps: [],
  yield: null,
  stated_times: { prep: null, cook: null, total: null },
});

const parse = (
  fact: Partial<ParseFact>,
): { parse: ParseFact; match: null; conversion: null; substitutions: null } => ({
  match: null,
  conversion: null,
  substitutions: null,
  parse: {
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
  },
});

// Each list item's parts, in order, as [class, text] pairs; a raw line is one text part.
function lines(markup: string): (string | [string, string])[][] {
  const doc = markup.replace(/<span class="ingredient-prep">(.*?)<\/span>/g, "$1");
  return [...doc.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map(([, inner = ""]) => {
    const parts = [...inner.matchAll(/<span class="([^"]+)">(.*?)<\/span>/g)];
    return parts.length
      ? parts.map(([, cls = "", text = ""]): [string, string] => [cls, text])
      : [inner];
  });
}

describe("Ingredients", () => {
  it("puts the name and preparation on the left and the amount on the right", () => {
    const markup = renderToStaticMarkup(
      <Ingredients
        original={original(["i1", "3 cloves garlic, minced", null])}
        facts={{
          ingredients: {
            i1: parse({
              quantity: { low: 3, high: 3 },
              unit: "cloves",
              name: "garlic",
              preparation: "minced",
            }),
          },
          steps: {},
          difficulty: null,
        }}
      />,
    );
    expect(lines(markup)).toEqual([
      [
        ["ingredient-name", "garlic, minced"],
        ["ingredient-amount", "3 cloves"],
      ],
    ]);
    expect(markup).toContain('<span class="ingredient-prep">, minced</span>');
    expect(markup.replace(/<[^>]+>/g, "")).toBe("garlic, minced 3 cloves");
  });

  it("follows the preparation with the line's remark, in the same secondary style", () => {
    const markup = renderToStaticMarkup(
      <Ingredients
        original={original(
          ["i1", "3 cloves garlic, minced, plus more for serving", null],
          ["i2", "1 tsp chili oil, or to taste", null],
        )}
        facts={{
          ingredients: {
            i1: parse({ name: "garlic", preparation: "minced", comment: "plus more for serving" }),
            i2: parse({
              quantity: { low: 1, high: 1 },
              unit: "tsp",
              name: "chili oil",
              comment: "or to taste",
            }),
          },
          steps: {},
          difficulty: null,
        }}
      />,
    );
    expect(lines(markup)).toEqual([
      [["ingredient-name", "garlic, minced, plus more for serving"]],
      [
        ["ingredient-name", "chili oil, or to taste"],
        ["ingredient-amount", "1 tsp"],
      ],
    ]);
    expect(markup).toContain('<span class="ingredient-prep">, or to taste</span>');
  });

  it("formats ranges, fractions and unit-less amounts, and shows no amount without a quantity", () => {
    const markup = renderToStaticMarkup(
      <Ingredients
        original={original(
          ["i1", "1-2 green onions", null],
          ["i2", "1 1/2 tbsp rice vinegar", null],
          ["i3", "2 eggs", null],
          ["i4", "salt, to taste", null],
        )}
        facts={{
          ingredients: {
            i1: parse({ quantity: { low: 1, high: 2 }, name: "green onions" }),
            i2: parse({ quantity: { low: 1.5, high: 1.5 }, unit: "tbsp", name: "rice vinegar" }),
            i3: parse({ quantity: { low: 2, high: 2 }, name: "eggs" }),
            i4: parse({ name: "salt" }),
          },
          steps: {},
          difficulty: null,
        }}
      />,
    );
    expect(lines(markup)).toEqual([
      [
        ["ingredient-name", "green onions"],
        ["ingredient-amount", "1–2"],
      ],
      [
        ["ingredient-name", "rice vinegar"],
        ["ingredient-amount", "1½ tbsp"],
      ],
      [
        ["ingredient-name", "eggs"],
        ["ingredient-amount", "2"],
      ],
      [["ingredient-name", "salt"]],
    ]);
  });

  it("shows a line without a parse fact as its raw text, under its Component heading", () => {
    const markup = renderToStaticMarkup(
      <Ingredients
        original={original(
          ["i1", "3 tbsp tahini", "For the sauce"],
          ["i2", "400 g firm tofu", "For the tofu"],
        )}
        facts={{
          ingredients: { i2: { parse: null, match: null, conversion: null, substitutions: null } },
          steps: {},
          difficulty: null,
        }}
      />,
    );
    expect([...markup.matchAll(/<h2>(.*?)<\/h2>/g)].map(([, h]) => h)).toEqual([
      "For the sauce",
      "For the tofu",
    ]);
    expect(lines(markup)).toEqual([["3 tbsp tahini"], ["400 g firm tofu"]]);
  });

  it("shows every line as raw text when there are no facts at all", () => {
    const markup = renderToStaticMarkup(
      <Ingredients original={original(["i1", "3 tbsp tahini", null])} />,
    );
    expect(markup).toBe(
      '<section class="component"><ul class="ingredients"><li>3 tbsp tahini</li></ul></section>',
    );
  });
});

describe("Steps", () => {
  it("marks a step's amount, reads naturally as text, and keeps a step without segments raw", () => {
    const fact = { provenance: "llm", confidence: 0.8, estimated: false } as const;
    const unconfirmed = {
      confirmed: false,
      confirmed_by: null,
      confirmed_at: null,
      confirm_batch: null,
    };
    const markup = renderToStaticMarkup(
      <Steps
        original={{
          ...original(["i1", "4 cloves garlic", null]),
          steps: [
            { id: "s1", component: null, text: "Add half the garlic." },
            { id: "s2", component: null, text: "Add the rest of the garlic." },
          ],
        }}
        facts={{
          ingredients: {
            i1: parse({ quantity: { low: 4, high: 4 }, unit: "cloves", name: "garlic" }),
          },
          steps: {
            s1: {
              segments: {
                ...fact,
                ...unconfirmed,
                segments: [
                  { t: "text", v: "Add " },
                  { t: "ingredient", ref: "i1", written: "half the garlic", portion: 0.5 },
                  { t: "text", v: "." },
                ],
              },
              uses: { ...fact, ...unconfirmed, uses: [{ ref: "i1", portion: 0.5 }] },
            },
            s2: {
              segments: null,
              uses: { ...fact, ...unconfirmed, uses: [{ ref: "i1", portion: 0.5 }] },
            },
          },
          difficulty: null,
        }}
      />,
    );
    expect(markup).toContain('<span class="step-amount">2 cloves</span> garlic');
    expect(
      [...markup.matchAll(/<li>(.*?)<\/li>/g)].map(([, li = ""]) => li.replace(/<[^>]+>/g, "")),
    ).toEqual(["Add 2 cloves garlic.", "Add the rest of the garlic."]);
  });
});
