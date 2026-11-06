import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalIngredient } from "./api/client";
import { CategoryRow, KitchenSettingsScreen } from "./KitchenSettingsScreen";

// What the screen shows, and whether this device's person is an editor.
const shown: {
  loaded: boolean;
  ingredients: CanonicalIngredient[];
  editor: boolean;
  offline?: boolean;
} = { loaded: true, ingredients: [], editor: false };
vi.mock("./collection", () => ({
  useCollection: () =>
    shown.loaded
      ? {
          state: "ready",
          value: {
            canonical_ingredients: shown.ingredients,
            kitchen_settings: {
              version: 1,
              schema_version: 1,
              store_categories: [
                { id: "produce", name: "Produce" },
                { id: "dairy", name: "Dairy" },
              ],
            },
          },
        }
      : { state: "failed", notFound: false, retry: () => {} },
  useSync: () => undefined,
}));
vi.mock("./session", () => ({
  useIsEditor: () => shown.editor,
  EditorOnly: ({
    children,
    fallback,
  }: {
    children: React.ReactNode;
    fallback?: React.ReactNode;
  }) => (shown.editor ? children : (fallback ?? null)),
}));
vi.mock("./online", () => ({ useOnline: () => !shown.offline }));
vi.mock("./AccountMenu", () => ({ AccountMenu: () => null }));

const ingredient = (
  id: string,
  name: string,
  store_category_id: string,
  fields: Partial<CanonicalIngredient> = {},
): CanonicalIngredient => ({
  id,
  name,
  family: name,
  store_category_id,
  confirmed: true,
  confirm_batch: null,
  pantry_staple: false,
  schema_version: 1,
  version: 1,
  ...fields,
});
const BUTTER = ingredient("c1", "butter", "dairy", { confirmed: false });
const APPLE = ingredient("c2", "apple", "produce", { pantry_staple: true });

const render = () =>
  renderToStaticMarkup(
    <MemoryRouter>
      <KitchenSettingsScreen />
    </MemoryRouter>,
  );
// Each button's text; the Back button is an icon.
const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(([, label]) =>
    label?.replace(/<[^>]*>/g, ""),
  );

beforeEach(() => {
  shown.loaded = true;
  shown.ingredients = [BUTTER, APPLE];
  shown.editor = false;
  shown.offline = false;
});

describe("KitchenSettingsScreen", () => {
  it("lists the Store Categories in their saved order", () => {
    const html = render();
    expect(html.indexOf(">Produce<")).toBeLessThan(html.indexOf(">Dairy<"));
    expect(html).toContain('aria-label="Store Categories"');
  });

  it("lists every Canonical Ingredient alphabetically with its Store Category", () => {
    const html = render();
    expect(html.indexOf(">apple<")).toBeLessThan(html.indexOf(">butter<"));
    expect(html).toMatch(/>butter<.*?Dairy/);
  });

  it("gives an unconfirmed Canonical Ingredient no review mark", () => {
    expect(render()).not.toContain("review-mark");
  });

  it("shows a visitor which are Pantry Staples, with no control", () => {
    const html = render();
    expect(html.match(/Pantry Staple</g)).toHaveLength(1);
    expect(html).not.toContain("aria-pressed");
    expect(buttons(html)).toEqual([""]);
  });

  it("gives an editor Edit and a toggle per row", () => {
    shown.editor = true;
    const html = render();
    expect(buttons(html)).toEqual(["", "Edit", "Pantry Staple apple", "Pantry Staple butter"]);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
  });

  it("turns both off while offline, and says why", () => {
    shown.editor = true;
    shown.offline = true;
    const html = render();
    expect(html.match(/<button[^>]*disabled/g)).toHaveLength(3);
    expect(html).toContain("You’re offline. Change the Kitchen settings once you’re back online.");
  });

  it("says when there are no Canonical Ingredients", () => {
    shown.ingredients = [];
    const html = render();
    expect(html).toContain("No Canonical Ingredients yet.");
    expect(html).not.toContain('type="search"');
  });

  it("says when the Collection couldn't load", () => {
    shown.loaded = false;
    expect(render()).toContain("The Kitchen settings couldn’t be loaded.");
  });

  describe("a Draft's row", () => {
    const row = (name: string, fields: Partial<Parameters<typeof CategoryRow>[0]> = {}) =>
      renderToStaticMarkup(
        <CategoryRow
          category={{ key: "dairy", name }}
          label="Dairy"
          canMoveUp
          canMoveDown
          canDelete
          canDrag
          onDelete={() => {}}
          onGrip={{}}
          dispatch={() => {}}
          {...fields}
        />,
      );

    it("names the category in its buttons, as the Draft has it", () => {
      expect(buttons(row("Mine")).slice(1)).toEqual([
        "Move up Mine",
        "Move down Mine",
        "Delete Mine",
      ]);
    });

    it("falls back to its saved name while the name is blank", () => {
      expect(buttons(row("  ")).slice(1)).toEqual([
        "Move up Dairy",
        "Move down Dairy",
        "Delete Dairy",
      ]);
    });

    it("turns Delete off for the last saved category, and says why", () => {
      const html = row("Dairy", { canDelete: false });
      expect(html).toMatch(/<button[^>]*disabled[^>]*>Delete/);
      expect(html).toContain("The last saved Store Category can’t be deleted.");
    });

    it("says an added category can move once it's saved, and turns its grip off", () => {
      const html = row("", {
        category: { key: "added-0", name: "", added: true },
        label: "New category",
        canMoveUp: false,
        canMoveDown: false,
        canDrag: false,
      });
      expect(html).toContain("It can move once it’s saved.");
      expect(html).toMatch(/<button[^>]*category-grip[^>]*disabled/);
    });
  });
});
