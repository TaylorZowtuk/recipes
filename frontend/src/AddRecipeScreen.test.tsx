import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { AddRecipeScreen } from "./AddRecipeScreen";

vi.mock("./collection", () => ({ useSync: () => undefined, forgetCollection: () => {} }));
vi.mock("./session", () => ({
  EditorOnly: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("./online", () => ({ useOnline: () => true }));
vi.mock("./AccountMenu", () => ({ AccountMenu: () => null }));

const render = (state?: unknown) =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[{ pathname: "/add", state }]}>
      <AddRecipeScreen />
    </MemoryRouter>,
  );

describe("AddRecipeScreen", () => {
  it("names the Favorite Site it was opened from and leaves the address empty", () => {
    const html = render({ fromSite: "Synthetic Kitchen" });
    expect(html).toContain(
      "Adding a recipe from Synthetic Kitchen. Find one at that site, then paste its address here.",
    );
    expect(html).toMatch(/<input[^>]*id="recipe-url"[^>]*value=""/);
  });

  it("shows no hint otherwise", () => {
    expect(render()).not.toContain("Adding a recipe from");
  });
});
