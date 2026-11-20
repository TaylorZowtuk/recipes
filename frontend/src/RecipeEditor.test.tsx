// @vitest-environment jsdom
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api/client";
import { draftOf } from "./editRecipe";
import { RecipeEditor } from "./RecipeEditor";
import { collection, recipe } from "./review.fixtures";

const reload = vi.hoisted(() => ({ before: () => {} }));
vi.mock("./collection", () => ({
  forgetCollection: () => {},
  rememberRecipe: () => {},
  useSync: () => undefined,
  reloadCollection: async () => {
    reload.before();
    return true;
  },
}));
vi.mock("./online", () => ({ useOnline: () => true }));

describe("the recipe editor", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  // The reloaded Collection drops a recipe deleted elsewhere, which takes the editor off the page
  // before the save settles. The page that owns the notice is still there to show it.
  it("still settles a conflict when the reload has taken the editor away", async () => {
    vi.spyOn(api, "PATCH").mockResolvedValue({
      error: { detail: "Recipe not found" },
      response: new Response(null, { status: 404 }),
    } as never);
    reload.before = () => flushSync(() => root.render(null));
    const dispatch = vi.fn();
    const r = recipe();
    act(() =>
      root.render(
        <MemoryRouter>
          <RecipeEditor
            recipe={r}
            title={r.original.title}
            collection={collection}
            draft={{ ...draftOf(r), tags: "quick" }}
            dispatch={dispatch}
          />
        </MemoryRouter>,
      ),
    );
    const save = host.querySelector<HTMLButtonElement>("button[type=submit]");
    await act(async () => save?.click());

    expect(dispatch).toHaveBeenCalledWith({
      type: "settled",
      outcome: { kind: "conflict" },
      refreshed: true,
      nowReady: false,
    });
  });

  // Cancel would unmount the editor while the save is still out; the save's outcome then lands on
  // whatever Draft the page has by then.
  it("keeps Cancel from leaving the editor while a save is pending", async () => {
    let finish: (value: never) => void = () => {};
    vi.spyOn(api, "PATCH").mockReturnValue(new Promise((resolve) => (finish = resolve)) as never);
    reload.before = () => {};
    const dispatch = vi.fn();
    const r = recipe();
    act(() =>
      root.render(
        <MemoryRouter>
          <RecipeEditor
            recipe={r}
            title={r.original.title}
            collection={collection}
            draft={{ ...draftOf(r), tags: "quick" }}
            dispatch={dispatch}
          />
        </MemoryRouter>,
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>("button[type=submit]")?.click());
    const cancel = [...host.querySelectorAll("button")].find((b) => b.textContent === "Cancel");
    act(() => cancel?.click());

    expect(dispatch).not.toHaveBeenCalledWith({ type: "cancel" });
    expect(cancel?.getAttribute("aria-disabled")).toBe("true");
    await act(async () =>
      finish({ error: { detail: "x" }, response: new Response(null, { status: 500 }) } as never),
    );
  });

  const render = (r = recipe(), problem?: string) => {
    const dispatch = vi.fn();
    act(() =>
      root.render(
        <MemoryRouter>
          <RecipeEditor
            recipe={r}
            title={r.original.title}
            collection={collection}
            draft={draftOf(r)}
            problem={problem}
            dispatch={dispatch}
          />
        </MemoryRouter>,
      ),
    );
    return dispatch;
  };
  const button = (name: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === name);

  it("lists Our Version's lines and steps, and drafts a removed line in the same Draft", () => {
    const dispatch = render();
    const rows = [...host.querySelectorAll(".our-version-row")].map(
      (row) => row.querySelector(".our-version-text")?.textContent,
    );
    expect(rows).toEqual([
      "2 tbsp butter",
      "2 cloves garlic",
      "2 cups flour or rice flour",
      "salt",
      "Melt the butter.",
      "Serve.",
    ]);
    act(() => button("Remove 2 cups flour or rice flour")?.click());
    const action = dispatch.mock.calls[0]?.[0];
    expect(action.type).toBe("change");
    expect(action.change.ours.ingredients.remove).toEqual(["i3"]);
  });

  it("sends Our Version in the one PATCH, only once it changed", async () => {
    const patch = vi.spyOn(api, "PATCH").mockResolvedValue({
      data: recipe(),
      response: new Response(null, { status: 200 }),
    } as never);
    reload.before = () => {};
    const r = recipe();
    const draft = draftOf(r);
    const removed = { ...draft.ours, ingredients: { ...draft.ours.ingredients, remove: ["i3"] } };
    act(() =>
      root.render(
        <MemoryRouter>
          <RecipeEditor
            recipe={r}
            title={r.original.title}
            collection={collection}
            draft={{ ...draft, tags: "quick", ours: removed }}
            dispatch={vi.fn()}
          />
        </MemoryRouter>,
      ),
    );
    const save = host.querySelector<HTMLButtonElement>("button[type=submit]");
    expect(save?.textContent).toBe("Save 2 changes");
    await act(async () => save?.click());
    const [, options] = patch.mock.calls[0] as unknown as [
      string,
      { body: { operations: unknown[] } },
    ];
    expect(options.body.operations).toEqual([
      { op: "set_tags", tags: ["quick"] },
      {
        op: "set_our_version",
        our_version: {
          ingredients: { edit: {}, remove: ["i3"], add: [] },
          steps: { edit: {}, remove: [], add: [] },
          note: null,
        },
      },
    ]);
  });

  it("offers no Our Version on a Pending recipe", () => {
    render(recipe({ status: "pending" }));
    expect(host.querySelector(".our-version-field")).toBeNull();
  });

  it("shows the API's refusal of an Our Version line by that line", () => {
    render(recipe(), "Line i2 needs an FDC food: the closest if none fits");
    const alerts = [...host.querySelectorAll('[role="alert"]')];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.closest(".our-version-row")?.textContent).toContain("2 cloves garlic");
  });
});
