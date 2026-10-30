import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { Card } from "./api/client";
import { RecipeCard } from "./CollectionScreen";

const card = (fields: Partial<Card>): Card => ({
  id: "01K7TEST000000000000000001",
  title: "Synthetic Test Noodles",
  site_name: "example.com",
  stated_seconds: 1800,
  status: "ready",
  preview: null,
  difficulty: null,
  tags: [],
  needs_review: { open_issues: 0, unconfirmed: 0 },
  recipe_version: 1,
  schema_version: 1,
  ...fields,
});

const render = (c: Card) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <RecipeCard card={c} />
    </MemoryRouter>,
  );

describe("RecipeCard", () => {
  it("shows the Difficulty and up to four Tags", () => {
    const markup = render(
      card({
        difficulty: { prep: 1, cook: 2, cleanup: 2 },
        tags: ["weeknight", "vegetarian", "noodles", "spicy", "make ahead"],
      }),
    );
    expect(markup).toContain(
      'aria-label="Difficulty: Prep 1 of 3, Cook 2 of 3, Cleanup 2 of 3, total 5 of 9"',
    );
    expect(markup).toContain(">spicy</li>");
    expect(markup).not.toContain("make ahead");
    expect(markup).toContain("+1<span");
  });

  it("leaves out the Difficulty and Tags a recipe doesn't have", () => {
    const markup = render(card({}));
    expect(markup).not.toContain("difficulty");
    expect(markup).not.toContain("tag");
  });
});
