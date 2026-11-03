import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Card } from "./api/client";
import { CollectionScreen, RecipeCard } from "./CollectionScreen";

// The Collection the screen shows, and whether this device's person is an editor.
const shown: { cards: Card[]; editor: boolean } = { cards: [], editor: false };
vi.mock("./collection", () => ({
  useCollection: () => ({ state: "ready", value: { cards: shown.cards } }),
}));
vi.mock("./session", () => ({
  useIsEditor: () => shown.editor,
  EditorOnly: ({ children }: { children: React.ReactNode }) => (shown.editor ? children : null),
}));
vi.mock("./AccountMenu", () => ({ AccountMenu: () => null }));

const card = (fields: Partial<Card>): Card => ({
  id: "01K7TEST000000000000000001",
  title: "Synthetic Test Noodles",
  site_name: "example.com",
  stated_seconds: 1800,
  status: "ready",
  preview: null,
  difficulty: null,
  difficulty_suggested: false,
  tags: [],
  needs_review: { open_issues: 0, unconfirmed: 0 },
  recipe_version: 1,
  schema_version: 1,
  ...fields,
});

const render = (c: Card, review = false) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <RecipeCard card={c} review={review} />
    </MemoryRouter>,
  );

const renderScreen = () =>
  renderToStaticMarkup(
    <MemoryRouter>
      <CollectionScreen />
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

  it("labels a Suggested Difficulty as a suggestion", () => {
    const markup = render(
      card({ difficulty: { prep: 1, cook: 2, cleanup: 2 }, difficulty_suggested: true }),
    );
    expect(markup).toContain(
      'aria-label="Suggested difficulty: Prep 1 of 3, Cook 2 of 3, Cleanup 2 of 3, total 5 of 9"',
    );
    expect(markup).toContain(">Suggested</span>");
  });

  it("leaves out the Difficulty and Tags a recipe doesn't have", () => {
    const markup = render(card({}));
    expect(markup).not.toContain("difficulty");
    expect(markup).not.toContain("tag");
  });
});

describe("RecipeCard under Needs Review", () => {
  it("shows its status and how many items are flagged and to check", () => {
    const markup = render(
      card({ status: "awaiting_review", needs_review: { open_issues: 1, unconfirmed: 3 } }),
      true,
    );
    expect(markup).toContain(">Awaiting Review</span>");
    expect(markup).toContain(">3 to check, incl. 1 flagged</span>");
  });

  it("leaves out the counts outside Needs Review", () => {
    const markup = render(
      card({ status: "awaiting_review", needs_review: { open_issues: 1, unconfirmed: 3 } }),
    );
    expect(markup).not.toContain("flagged");
    expect(markup).not.toContain("Awaiting Review");
  });
});

describe("the Needs Review chip", () => {
  beforeEach(() => {
    shown.cards = [
      card({ id: "a", title: "Synthetic Beans", needs_review: { open_issues: 1, unconfirmed: 0 } }),
      card({ id: "b", title: "Synthetic Dal", needs_review: { open_issues: 0, unconfirmed: 2 } }),
      card({ id: "c", title: "Synthetic Eggs" }),
    ];
  });

  it("starts the chip row for an editor, counting the cards with unchecked items", () => {
    shown.editor = true;
    const markup = renderScreen();
    expect(markup).toMatch(
      /<ul class="chips chips-row" aria-label="Filter by Tag"><li><button type="button" class="chip chip-review" aria-pressed="false">Needs Review · 2<\/button>/,
    );
  });

  it("shows even when the Collection has no Tags", () => {
    shown.editor = true;
    expect(shown.cards.every((c) => c.tags.length === 0)).toBe(true);
    expect(renderScreen()).toContain("Needs Review · 2");
  });

  it("isn't shown when nothing needs review", () => {
    shown.editor = true;
    shown.cards = [card({})];
    expect(renderScreen()).not.toContain("Needs Review");
  });

  it("isn't shown to a visitor", () => {
    shown.editor = false;
    expect(renderScreen()).not.toContain("Needs Review");
  });
});
