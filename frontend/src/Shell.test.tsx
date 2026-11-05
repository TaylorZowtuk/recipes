import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Card } from "./api/client";
import { Shell } from "./Shell";

const shown: { cards: Card[]; editor: boolean } = { cards: [], editor: false };
vi.mock("./collection", () => ({
  useCollection: () => ({ state: "ready", value: { cards: shown.cards } }),
  useSync: () => undefined,
}));
vi.mock("./session", () => ({
  useIsEditor: () => shown.editor,
  EditorOnly: ({ children }: { children: React.ReactNode }) => (shown.editor ? children : null),
}));
vi.mock("./online", () => ({ useOnline: () => true }));
vi.mock("./AccountMenu", () => ({ AccountMenu: () => null }));

const card = (fields: Partial<Card>): Card => ({
  id: "01K7TEST000000000000000001",
  title: "Synthetic Test Noodles",
  site_name: null,
  stated_seconds: null,
  status: "ready",
  preview: null,
  difficulty: null,
  difficulty_suggested: false,
  tags: [],
  needs_review: { open_issues: 0, unconfirmed: 0, flagged: 0 },
  recipe_version: 1,
  host: null,
  schema_version: 1,
  ...fields,
});

const render = () =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={["/week"]}>
      <Shell />
    </MemoryRouter>,
  );

describe("Shell", () => {
  beforeEach(() => {
    shown.cards = [card({ needs_review: { open_issues: 1, unconfirmed: 1, flagged: 1 } })];
  });

  it("marks the Recipes tab with a dot for an editor while anything needs review", () => {
    shown.editor = true;
    const markup = render();
    expect(markup).toContain('class="place-dot"');
    expect(markup).toContain('Recipes<span class="visually-hidden">(needs review)</span>');
  });

  it("shows no dot once nothing needs review", () => {
    shown.editor = true;
    shown.cards = [card({})];
    expect(render()).not.toContain("place-dot");
  });

  it("shows a visitor no dot", () => {
    shown.editor = false;
    expect(render()).not.toContain("place-dot");
  });
});
