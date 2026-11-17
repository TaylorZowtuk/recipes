import { describe, expect, it } from "vitest";
import {
  type AdjustChoices,
  CONFIDENCE_THRESHOLD,
  lineAmount,
  nextUnit,
  temperature,
  type Units,
  unitOptions,
  weightRefusal,
} from "./adjust";
import type { ConversionFact, Factor, IngredientFacts, ParseFact } from "./api/client";

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

const conversion = (fact: Partial<ConversionFact>): ConversionFact => ({
  provenance: "fdc",
  confidence: 0.9,
  estimated: false,
  confirmed: true,
  confirmed_by: "editor",
  confirmed_at: "2026-11-01T00:00:00Z",
  confirm_batch: null,
  dataset: "foundation",
  fdc_id: 1,
  release: "2025-04",
  per_100g: {} as ConversionFact["per_100g"],
  density_g_per_ml: null,
  grams_per_count: null,
  count_unit: null,
  refused: null,
  ...fact,
});

// A line of `amount` `unit` (a number, or [low, high]), with an optional conversion.
function line(
  amount: number | [number, number] | null,
  unit: string | null,
  unit_kind: ParseFact["unit_kind"],
  conv: ConversionFact | null = null,
): IngredientFacts {
  const [low, high] = typeof amount === "number" ? [amount, amount] : (amount ?? [0, 0]);
  return {
    parse: parse({ quantity: amount === null ? null : { low, high }, unit, unit_kind }),
    match: null,
    conversion: conv,
    substitutions: null,
  };
}

const at = (units: Units, scale: Factor = 1): AdjustChoices => ({ scale, units });
const show = (l: IngredientFacts, units: Units, scale: Factor = 1) =>
  lineAmount(l, at(units, scale));

const flour = conversion({ density_g_per_ml: 0.5 }); // 1 cup ≈ 118 g
const eggs = conversion({ grams_per_count: 50, count_unit: "large" });
const cloves = conversion({ grams_per_count: 3, count_unit: "clove" });

describe("As written", () => {
  it("shows exactly the written unit at 1×", () => {
    expect(show(line(3, "tsp", "volume"), "written")).toBe("3 tsp");
    expect(show(line(16, "tbsp", "volume"), "written")).toBe("16 tbsp");
    expect(show(line(1.5, "cup", "volume"), "written")).toBe("1½ cups");
    expect(show(line(400, "g", "mass"), "written")).toBe("400 g");
  });

  it("scales in kitchen fractions", () => {
    expect(show(line(4, "cloves", "count"), "written", 3)).toBe("12 cloves");
    expect(show(line(2, null, "count"), "written", 0.5)).toBe("1");
    expect(show(line(400, "g", "mass"), "written", 1.5)).toBe("600 g");
    expect(show(line(1, "lb", "mass"), "written", 1.5)).toBe("1½ lb");
  });

  it("tidies scaled spoons and cups to the friendliest kitchen unit", () => {
    expect(show(line(1, "tsp", "volume"), "written", 3)).toBe("1 tbsp");
    expect(show(line(8, "tbsp", "volume"), "written", 2)).toBe("1 cup");
    expect(show(line(16, "tsp", "volume"), "written", 3)).toBe("1 cup");
    expect(show(line(1 / 3, "cup", "volume"), "written", 1.5)).toBe("½ cup");
    expect(show(line(2, "tsp", "volume"), "written", 3)).toBe("2 tbsp");
    // A small cup amount falls back to spoons.
    expect(show(line(1 / 4, "cup", "volume"), "written", 0.5)).toBe("2 tbsp");
    expect(show(line(1 / 3, "cup", "volume"), "written", 0.5)).toBe("2⅔ tbsp");
    expect(show(line(1, "tsp", "volume"), "written", 0.5)).toBe("½ tsp");
  });

  it("tidies a range by its high end, in cups only as ¼, ⅓, ½, ⅔ or ¾", () => {
    expect(show(line([0.5, 3], "tbsp", "volume"), "written", 1.5)).toBe("¾–4½ tbsp");
    expect(show(line(2, "tbsp", "volume"), "written", 3)).toBe("6 tbsp");
    expect(show(line([100, 500], "ml", "volume"), "us", 0.5)).toBe("¼–1 cup");
    // A low end under ⅛ of the larger unit keeps the smaller one.
    expect(show(line([1, 50], "ml", "volume"), "us")).toBe("¼–10⅛ tsp");
  });
});

describe("Metric", () => {
  it("converts weights to g, and kg from 1000 g", () => {
    expect(show(line(8, "oz", "mass"), "metric")).toBe("227 g");
    expect(show(line(1, "lb", "mass"), "metric", 3)).toBe("1.36 kg");
    expect(show(line(2.2046226, "lb", "mass"), "metric")).toBe("1 kg");
  });

  it("converts cups, fl oz, pints, quarts and gallons to ml, and l from 1000 ml", () => {
    expect(show(line(1, "cup", "volume"), "metric")).toBe("237 ml");
    expect(show(line(2, "floz", "volume"), "metric")).toBe("59 ml");
    expect(show(line(1, "pt", "volume"), "metric")).toBe("473 ml");
    expect(show(line(1, "qt", "volume"), "metric", 2)).toBe("1.89 l");
    expect(show(line(1, "gal", "volume"), "metric")).toBe("3.79 l");
  });

  it("keeps spoons as spoons, tidied when scaled", () => {
    expect(show(line(1, "tbsp", "volume"), "metric")).toBe("1 tbsp");
    expect(show(line(1, "tsp", "volume"), "metric", 3)).toBe("1 tbsp");
    expect(show(line(8, "tbsp", "volume"), "metric", 2)).toBe("16 tbsp");
  });

  it("keeps counts and metric units", () => {
    expect(show(line(4, "cloves", "count"), "metric", 2)).toBe("8 cloves");
    expect(show(line(250, "ml", "volume"), "metric")).toBe("250 ml");
  });

  it("shows metric units as decimals, rescaled between g and kg, ml and l", () => {
    expect(show(line(1.5, "kg", "mass"), "metric", 0.5)).toBe("750 g");
    expect(show(line(600, "ml", "volume"), "metric", 2)).toBe("1.2 l");
    expect(show(line(1.5, "kg", "mass"), "metric")).toBe("1.5 kg");
    expect(show(line(2.5, "g", "mass"), "metric")).toBe("2.5 g");
    expect(show(line(250, "g", "mass"), "metric", 1.5)).toBe("375 g");
  });
});

describe("US", () => {
  it("converts weights to oz, and lb from 16 oz", () => {
    expect(show(line(100, "g", "mass"), "us")).toBe("3½ oz");
    expect(show(line(1, "kg", "mass"), "us")).toBe("2¼ lb");
    expect(show(line(454, "g", "mass"), "us")).toBe("1 lb");
  });

  it("converts ml and l to spoons and cups", () => {
    expect(show(line(250, "ml", "volume"), "us")).toBe("1 cup");
    expect(show(line(15, "ml", "volume"), "us")).toBe("1 tbsp");
    expect(show(line(5, "ml", "volume"), "us")).toBe("1 tsp");
    expect(show(line(2, "l", "volume"), "us")).toBe("8½ cups");
  });

  it("keeps US units", () => {
    expect(show(line(1, "lb", "mass"), "us")).toBe("1 lb");
    expect(show(line(1 / 3, "cup", "volume"), "us")).toBe("⅓ cup");
  });

  it("keeps US units in kitchen fractions, with oz to lb from 16 oz", () => {
    expect(show(line(8, "oz", "mass"), "us", 2)).toBe("1 lb");
    expect(show(line(12, "oz", "mass"), "us", 3)).toBe("2¼ lb");
    expect(show(line(6, "oz", "mass"), "us", 0.5)).toBe("3 oz");
    expect(show(line(1, "lb", "mass"), "us", 0.5)).toBe("½ lb");
  });
});

describe("As written, scaled", () => {
  it("keeps the written unit", () => {
    expect(show(line(8, "oz", "mass"), "written", 2)).toBe("16 oz");
  });

  it("shows a metric unit as decimals, rescaled between g and kg, ml and l", () => {
    expect(show(line(125, "g", "mass"), "written", 1.5)).toBe("188 g");
    expect(show(line(1.5, "kg", "mass"), "written", 0.5)).toBe("750 g");
    expect(show(line(5, "ml", "volume"), "written", 0.5)).toBe("2.5 ml");
  });

  it("makes a count unit plural or singular as the amount is, in every unit system", () => {
    for (const units of ["written", "metric", "us"] as const) {
      expect(show(line(1, "clove", "count"), units, 2)).toBe("2 cloves");
      expect(show(line(2, "cloves", "count"), units, 0.5)).toBe("1 clove");
      expect(show(line([1, 2], "cloves", "count"), units, 0.5)).toBe("½–1 clove");
      expect(show(line([1, 2], "clove", "count"), units, 1.5)).toBe("1½–3 cloves");
    }
  });
});

describe("unit systems", () => {
  it("never turn a volume into a weight or a weight into a volume", () => {
    for (const units of ["written", "metric", "us"] as const) {
      expect(show(line(1, "cup", "volume", flour), units)).not.toMatch(/g$|oz$/);
      expect(show(line(100, "g", "mass", flour), units)).not.toMatch(/ml|cup|tsp|tbsp/);
    }
  });

  it("never mark a same-kind conversion ≈", () => {
    expect(show(line(8, "oz", "mass"), "metric")).not.toContain("≈");
    expect(show(line(250, "ml", "volume"), "us")).not.toContain("≈");
  });

  it("scale and convert both ends of a range", () => {
    expect(show(line([1, 2], "cup", "volume"), "metric")).toBe("237–473 ml");
    expect(show(line([1, 2], null, "count"), "written", 2)).toBe("2–4");
    expect(show(line([1, 2], "tsp", "volume"), "written", 3)).toBe("1–2 tbsp");
  });

  it("leave a line with no amount as its unit, or nothing", () => {
    expect(show(line(null, null, null), "metric", 2)).toBe("");
    expect(show(line(null, "pinch", "count"), "us", 2)).toBe("pinch");
    expect(
      lineAmount({ parse: null, match: null, conversion: null, substitutions: null }, at("us")),
    ).toBe("");
  });
});

describe("unitOptions and nextUnit", () => {
  it("cycles a volume through both systems' volumes, then ≈ g and ≈ oz", () => {
    const l = line(1, "cup", "volume", flour);
    expect(unitOptions(l, at("written"))).toEqual(["written", "metric", "g", "oz"]);
    expect(unitOptions(l, at("metric"))).toEqual(["metric", "us", "g", "oz"]);
    expect(lineAmount(l, at("written"), "g")).toBe("≈ 118 g");
    expect(lineAmount(l, at("written"), "oz")).toBe("≈ 4⅛ oz");
    expect(nextUnit(l, at("written"))).toBe("metric");
    expect(nextUnit(l, at("written"), "metric")).toBe("g");
    expect(nextUnit(l, at("written"), "oz")).toBe("written");
  });

  it("never offers ml for spoons", () => {
    const l = line(1, "tbsp", "volume", flour);
    expect(unitOptions(l, at("written"))).toEqual(["written", "g", "oz"]);
    expect(unitOptions(line(1, "tbsp", "volume"), at("metric"))).toEqual(["metric"]);
  });

  it("cycles a weight between g and oz", () => {
    expect(unitOptions(line(100, "g", "mass"), at("written"))).toEqual(["written", "us"]);
    expect(unitOptions(line(8, "oz", "mass"), at("us"))).toEqual(["us", "metric"]);
  });

  it("cycles a count to ≈ g and ≈ oz when its count fits", () => {
    const egg = line(2, null, "count", eggs);
    expect(unitOptions(egg, at("written"))).toEqual(["written", "g", "oz"]);
    expect(lineAmount(egg, at("written", 2), "g")).toBe("≈ 200 g");
    const garlic = line(4, "cloves", "count", cloves);
    expect(unitOptions(garlic, at("us"))).toEqual(["us", "g", "oz"]);
    expect(lineAmount(garlic, at("us"), "g")).toBe("≈ 12 g");
    const can = line(1, "can", "count", cloves);
    expect(unitOptions(can, at("us"))).toEqual(["us"]);
  });

  it("counts as the API does: in the line's own unit, or a bare count for a line with none", () => {
    const options = (amount: IngredientFacts) => unitOptions(amount, at("written"));
    expect(options(line(3, "Clove(s)", "count", cloves))).toContain("g");
    expect(options(line(3, "cloves", "count", cloves))).toContain("g");
    expect(
      options(line(2, null, "count", conversion({ grams_per_count: 9, count_unit: "medium" }))),
    ).toContain("g");
    expect(options(line(2, null, "count", cloves))).toEqual(["written"]);
    expect(weightRefusal(line(2, null, "count", cloves))).toBe(
      "No weight known for this ingredient yet",
    );
    const uncounted = conversion({ grams_per_count: 50, count_unit: null });
    expect(options(line(2, null, "count", uncounted))).toEqual(["written"]);
  });

  it("has one option when nothing converts", () => {
    expect(unitOptions(line(1, "cup", "volume"), at("written"))).toEqual(["written", "metric"]);
    expect(unitOptions(line(3, "cloves", "count"), at("written"))).toEqual(["written"]);
    expect(nextUnit(line(3, "cloves", "count"), at("written"))).toBe("written");
  });

  it("falls back to the system's unit for a choice no longer offered", () => {
    expect(lineAmount(line(1, "cup", "volume"), at("written"), "g")).toBe("1 cup");
  });
});

describe("a tiny amount", () => {
  const yeast = line(1 / 8, "tsp", "volume", conversion({ density_g_per_ml: 0.6 }));

  it("shows grams under 10 to one decimal place", () => {
    expect(lineAmount(yeast, at("written"), "g")).toBe("≈ 0.4 g");
    expect(show(line(0.1, "oz", "mass"), "metric")).toBe("2.8 g");
    expect(show(line(0.35, "oz", "mass"), "metric")).toBe("9.9 g");
  });

  it("shows under ⅛ oz when it rounds below ⅛ oz", () => {
    expect(lineAmount(yeast, at("written"), "oz")).toBe("≈ under ⅛ oz");
    expect(show(line(200, "mg", "mass"), "us")).toBe("under ⅛ oz");
    expect(show(line(1, "g", "mass"), "us")).toBe("under ⅛ oz");
    expect(show(line(3, "g", "mass"), "us")).toBe("⅛ oz");
    expect(show(line([1, 10], "g", "mass"), "us")).toBe("⅛–⅜ oz");
  });

  it("shows a volume of at least ⅛ tsp", () => {
    expect(show(line(0.5, "ml", "volume"), "us")).toBe("⅛ tsp");
  });
});

describe("the Confidence Threshold", () => {
  it("is confirmed and a confidence of at least 0.8", () => {
    expect(CONFIDENCE_THRESHOLD).toBe(0.8);
    const weighs = (c: ConversionFact) => unitOptions(line(1, "cup", "volume", c), at("written"));
    expect(weighs(conversion({ density_g_per_ml: 0.5, confidence: 0.8 }))).toContain("g");
    expect(weighs(conversion({ density_g_per_ml: 0.5, confidence: 0.79 }))).not.toContain("g");
    expect(weighs(conversion({ density_g_per_ml: 0.5, confirmed: false }))).not.toContain("g");
    expect(weighs(conversion({ density_g_per_ml: 0.5, refused: "no" }))).not.toContain("g");
    expect(weighs(conversion({ grams_per_count: 50 }))).not.toContain("g");
  });
});

describe("weightRefusal", () => {
  const cup = (c: ConversionFact | null) => weightRefusal(line(1, "cup", "volume", c));

  it("says nothing when a weight is offered, or the line is a weight", () => {
    expect(cup(flour)).toBeUndefined();
    expect(weightRefusal(line(100, "g", "mass"))).toBeUndefined();
  });

  it("says an editor kept it in the written unit", () => {
    expect(cup(conversion({ refused: "kept in the written unit by an editor" }))).toBe(
      "An editor kept this in the written unit",
    );
  });

  it("says the conversion hasn't been checked", () => {
    expect(cup(conversion({ density_g_per_ml: 0.5, confirmed: false }))).toBe(
      "This conversion hasn't been checked yet",
    );
    expect(cup(conversion({ density_g_per_ml: 0.5, confidence: 0.5 }))).toBe(
      "This conversion hasn't been checked yet",
    );
  });

  it("says no weight is known otherwise", () => {
    const none = "No weight known for this ingredient yet";
    expect(cup(null)).toBe(none);
    expect(cup(conversion({ refused: "no portion chosen" }))).toBe(none);
    expect(cup(conversion({ density_g_per_ml: 0.5, refused: "no portion chosen" }))).toBe(none);
    expect(cup(conversion({ grams_per_count: 50 }))).toBe(none);
  });
});

describe("temperature", () => {
  const oven = { t: "temperature", c: 218, written: "425°F" } as const;

  it("shows it as written, in °C or in °F, to the nearest 5", () => {
    expect(temperature(oven, "written")).toBe("425°F");
    expect(temperature(oven, "metric")).toBe("220°C");
    expect(temperature(oven, "us")).toBe("425°F");
    expect(temperature({ t: "temperature", c: 180, written: "180°C" }, "us")).toBe("355°F");
  });

  it("keeps a temperature already in the chosen system as written", () => {
    expect(temperature({ t: "temperature", c: 63, written: "63°C" }, "metric")).toBe("63°C");
    expect(temperature({ t: "temperature", c: 114.4, written: "238°F" }, "us")).toBe("238°F");
    expect(temperature({ t: "temperature", c: 63, written: "63°C" }, "written")).toBe("63°C");
  });
});
