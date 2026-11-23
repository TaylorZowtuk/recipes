import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Card, Recipe } from "./api/client";
import { engine, reloadCollection, rememberRecipe, useRecipe } from "./collection";
import { SCHEMA_VERSION } from "./schemaVersion";

// A session whose role the test sets, telling its subscribers.
const role = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const role = {
    isEditor: false,
    set(isEditor: boolean) {
      role.isEditor = isEditor;
      for (const listener of listeners) listener();
    },
    session: {
      getSnapshot: () => ({ isEditor: role.isEditor }),
      subscribe: (listener: () => void) => void listeners.add(listener),
    },
  };
  return role;
});
vi.mock("./session", () => ({ session: role.session }));

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

describe("signing in", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("starts the full prefetch for an editor signing in after the Collection loaded", async () => {
    vi.useFakeTimers();
    const ids = ["01K7TESTSIGNIN000000000001", "01K7TESTSIGNIN000000000002"];
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (path: string) => {
      requests.push(path);
      if (path === "/api/sync")
        return Response.json({ collection_version: 7, schema_version: SCHEMA_VERSION });
      if (path === "/api/v/collection/7")
        return Response.json({
          collection_version: 7,
          cards: ids.map((id) => ({ id, recipe_version: 1, preview: null })),
        });
      return Response.json({ id: path, version: 1 });
    });

    await engine.collection();
    await vi.runAllTimersAsync();
    await engine.settled();
    expect(requests.filter((path) => path.startsWith("/api/v/recipes/"))).toEqual([]);

    role.set(true);
    await vi.runAllTimersAsync();
    await engine.settled();
    expect(requests.filter((path) => path.startsWith("/api/v/recipes/"))).toEqual(
      ids.map((id) => `/api/v/recipes/${id}/1/${SCHEMA_VERSION}`),
    );
  });
});

describe("reloadCollection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("counts a bundle the API redirected to a newer version as reloaded", async () => {
    vi.stubGlobal("fetch", async (path: string) => {
      if (path === "/api/sync")
        return Response.json({ collection_version: 20, schema_version: SCHEMA_VERSION });
      if (path === "/api/v/collection/20") {
        // Another device wrote between the poll and the bundle, so the API redirected to 21.
        const response = Response.json({ collection_version: 21, cards: [] });
        return Object.defineProperty(response, "url", {
          value: "http://localhost/api/v/collection/21",
        });
      }
      return new Response(null, { status: 500 });
    });

    expect(await reloadCollection()).toBe(true);
    expect((await engine.collection()).collection_version).toBe(21);
    await engine.settled();
  });
});
