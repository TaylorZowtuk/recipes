import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Card, Recipe } from "./api/client";
import { rememberRecipe, useRecipe } from "./collection";

const ID = "01K7TESTCOLLECTION00000001";
const recipe = (version: number) => ({ id: ID, version }) as Recipe;
const card = (recipe_version: number) => ({ id: ID, recipe_version }) as Card;

// What useRecipe reports on first render, before any load settles.
function Shown({ at }: { at: Card }) {
  const loaded = useRecipe(at);
  return loaded.state === "ready"
    ? `v${loaded.value.version}${loaded.newerLoading ? " newer loading" : ""}`
    : loaded.state;
}
const shown = (at: Card) => renderToStaticMarkup(<Shown at={at} />);

describe("useRecipe", () => {
  it("shows the card's version from memory", () => {
    rememberRecipe(recipe(1));
    expect(shown(card(1))).toBe("v1");
  });

  it("keeps the older version on screen while the card's newer one loads, and says so", () => {
    rememberRecipe(recipe(1));
    expect(shown(card(2))).toBe("v1 newer loading");
  });
});
