import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Original, ParseFact } from "./api/client";
import { formatQuantity, Ingredients } from "./RecipeScreen";

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

const parse = (fact: Partial<ParseFact>): { parse: ParseFact } => ({
  parse: {
    quantity: null,
    unit: null,
    unit_kind: null,
    name: "ingredient",
    short_name: null,
    preparation: null,
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

describe("formatQuantity", () => {
  it("writes kitchen fractions and ranges", () => {
    expect(formatQuantity({ low: 1.5, high: 1.5 })).toBe("1½");
    expect(formatQuantity({ low: 0.25, high: 0.25 })).toBe("¼");
    expect(formatQuantity({ low: 0.75, high: 0.75 })).toBe("¾");
    expect(formatQuantity({ low: 1 / 3, high: 1 / 3 })).toBe("⅓");
    expect(formatQuantity({ low: 2, high: 2 })).toBe("2");
    expect(formatQuantity({ low: 1, high: 2 })).toBe("1–2");
    expect(formatQuantity({ low: 0.5, high: 1 })).toBe("½–1");
  });

  it("keeps an amount with no kitchen fraction as a short decimal", () => {
    expect(formatQuantity({ low: 1.15, high: 1.15 })).toBe("1.15");
  });
});

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
        facts={{ ingredients: { i2: { parse: null } } }}
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
