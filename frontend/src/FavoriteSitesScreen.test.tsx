import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CountedSite } from "./api/client";
import { FavoriteSitesScreen } from "./FavoriteSitesScreen";

// The Favorite Sites the screen shows, and whether this device's person is an editor.
const shown: {
  sites?: CountedSite[];
  editor: boolean;
  offline?: boolean;
} = { editor: false };
vi.mock("./collection", () => ({
  useCollection: () =>
    shown.sites
      ? { state: "ready", value: { favorite_sites: { version: 1, sites: shown.sites } } }
      : { state: "failed", notFound: false, retry: () => {} },
  useSync: () => undefined,
}));
vi.mock("./session", () => ({
  useIsEditor: () => shown.editor,
  EditorOnly: ({ children }: { children: React.ReactNode }) => (shown.editor ? children : null),
}));
vi.mock("./online", () => ({ useOnline: () => !shown.offline }));
vi.mock("./AccountMenu", () => ({ AccountMenu: () => null }));

const KITCHEN: CountedSite = {
  id: "01K7TEST0000000000000000F1",
  name: "Synthetic Kitchen",
  address: "https://kitchen.example.com/",
  note: "Weeknight dinners.",
  recipe_count: 3,
};
const BAKES: CountedSite = {
  id: "01K7TEST0000000000000000F2",
  name: "Synthetic Bakes",
  address: "https://bakes.example.com/bread",
  note: "",
  recipe_count: 1,
};

const render = () =>
  renderToStaticMarkup(
    <MemoryRouter>
      <FavoriteSitesScreen />
    </MemoryRouter>,
  );

beforeEach(() => {
  shown.sites = [KITCHEN, BAKES];
  shown.editor = false;
  shown.offline = false;
});

describe("FavoriteSitesScreen", () => {
  it("lists each site's name, address as a new-tab link, note and recipe count, in order", () => {
    const html = render();
    expect(html.indexOf("Synthetic Kitchen")).toBeLessThan(html.indexOf("Synthetic Bakes"));
    expect(html).toContain('href="https://kitchen.example.com/"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Weeknight dinners.");
    expect(html).toContain("3 recipes");
    expect(html).toContain("1 recipe<");
  });

  it("says so when there are no sites", () => {
    shown.sites = [];
    expect(render()).toContain("No Favorite Sites yet.");
  });

  it("says when the Collection couldn't load", () => {
    shown.sites = undefined;
    expect(render()).toContain("The Favorite Sites couldn’t be loaded.");
  });

  it("gives a visitor no way to edit or add", () => {
    const html = render();
    expect(html).not.toContain(">Edit<");
    expect(html).not.toContain("Add a recipe from this site");
  });

  it("gives an editor Edit and Add a recipe from this site", () => {
    shown.editor = true;
    const html = render();
    expect(html).toContain(">Edit<");
    expect(html.match(/Add a recipe from this site/g)).toHaveLength(2);
  });

  it("turns both off while offline, and says why", () => {
    shown.editor = true;
    shown.offline = true;
    const html = render();
    expect(html.match(/<button[^>]*disabled/g)).toHaveLength(3);
    expect(html).toContain("You’re offline. Edit the Favorite Sites once you’re back online.");
  });
});
