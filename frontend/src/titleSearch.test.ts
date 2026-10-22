import { describe, expect, it } from "vitest";
import { byTitle, titleMatches } from "./titleSearch";

describe("titleMatches", () => {
  it("matches a substring anywhere in the title", () => {
    expect(titleMatches("Sesame Noodles with Crispy Tofu", "crispy")).toBe(true);
    expect(titleMatches("Sesame Noodles with Crispy Tofu", "oodle")).toBe(true);
  });

  it("ignores case and accents on both sides", () => {
    expect(titleMatches("Crème Brûlée", "CREME BRU")).toBe(true);
    expect(titleMatches("Creme Brulee", "brûlée")).toBe(true);
  });

  it("ignores spaces around the query, and an empty query matches everything", () => {
    expect(titleMatches("Overnight Oats", "  oats ")).toBe(true);
    expect(titleMatches("Overnight Oats", "   ")).toBe(true);
  });

  it("doesn't match a title without the query", () => {
    expect(titleMatches("Overnight Oats", "tofu")).toBe(false);
  });
});

describe("byTitle", () => {
  it("sorts alphabetically, ignoring case and accents", () => {
    const titles = ["tomato soup", "Éclairs", "Apple Pie", "eggs"].map((title) => ({ title }));
    expect(titles.sort(byTitle).map((c) => c.title)).toEqual([
      "Apple Pie",
      "Éclairs",
      "eggs",
      "tomato soup",
    ]);
  });
});
