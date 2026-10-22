import { describe, expect, it } from "vitest";
import { recipePath, slug } from "./slug";

describe("slug", () => {
  it("lower-cases the title and joins its words with hyphens", () => {
    expect(slug("Sesame Noodles with Crispy Tofu")).toBe("sesame-noodles-with-crispy-tofu");
  });

  it("strips accents", () => {
    expect(slug("Crème Brûlée à l’Orange")).toBe("creme-brulee-a-l-orange");
  });

  it("turns each run of other characters into one hyphen and trims them from the ends", () => {
    expect(slug("  Mac & Cheese (Baked!) -- 2.0  ")).toBe("mac-cheese-baked-2-0");
  });

  it("falls back to 'recipe' when nothing in the title is a letter or digit", () => {
    expect(slug("¡¿?!")).toBe("recipe");
  });
});

describe("recipePath", () => {
  it("is the recipe's id followed by its title's slug", () => {
    expect(recipePath({ id: "01K7SEED000000000000000002", title: "Overnight Oats" })).toBe(
      "/recipes/01K7SEED000000000000000002/overnight-oats",
    );
  });
});
