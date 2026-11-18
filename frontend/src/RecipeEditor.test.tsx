// @vitest-environment jsdom
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api/client";
import { draftOf } from "./editRecipe";
import { RecipeEditor } from "./RecipeEditor";
import { recipe } from "./review.fixtures";

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
});
