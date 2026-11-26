// @vitest-environment jsdom
import { act, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api/client";
import { draftOf } from "./editRecipe";
import { OurVersionFields } from "./OurVersionEditor";
import { type OurDraft, ourDraftOf } from "./ourVersionDraft";
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

  const render = (
    r = recipe(),
    problem?: string,
    at?: { part: "ingredients" | "steps"; id: string },
    draft = draftOf(r),
  ) => {
    const dispatch = vi.fn();
    act(() =>
      root.render(
        <MemoryRouter>
          <RecipeEditor
            recipe={r}
            title={r.original.title}
            collection={collection}
            draft={draft}
            problem={problem}
            refusedAt={at}
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
          ingredients: { edit: {}, remove: ["i3"], add: [], substitutions: {} },
          steps: { edit: {}, remove: [], add: [] },
          note: null,
        },
      },
    ]);
  });

  it("moves the focus to Restore once Remove is pressed, and back again", () => {
    const r = recipe();
    function Fields() {
      const [draft, setDraft] = useState(ourDraftOf(r));
      return (
        <OurVersionFields
          recipe={r}
          draft={draft}
          collection={collection}
          onChange={setDraft}
          onOpen={() => {}}
        />
      );
    }
    act(() => root.render(<Fields />));
    const press = (name: string) => {
      const pressed = button(name);
      pressed?.focus();
      act(() => pressed?.click());
    };
    press("Remove 2 cups flour or rice flour");
    expect(document.activeElement?.textContent).toBe("Restore 2 cups flour or rice flour");
    press("Restore 2 cups flour or rice flour");
    expect(document.activeElement?.textContent).toBe("Remove 2 cups flour or rice flour");
  });

  it("shows each line's substitutes under it, and opens them to change", () => {
    const r = recipe();
    const onOpen = vi.fn();
    const start = ourDraftOf(r);
    const coconut = {
      canonical: { kind: "existing" as const, id: "01K7TESTCANON0000000000003" },
      wording: "coconut oil",
      ratio: 1,
      note: "",
      fdc_id: 171412,
      portion_id: null,
    };
    const draft = {
      ...start,
      ingredients: { ...start.ingredients, substitutions: { i1: [coconut], i3: [] } },
    };
    act(() =>
      root.render(
        <OurVersionFields
          recipe={r}
          draft={draft}
          collection={collection}
          onChange={() => {}}
          onOpen={onOpen}
        />,
      ),
    );
    const substitutes = (id: string) =>
      host.querySelector(`[data-row="ingredients ${id}"] .our-version-substitutes`)?.textContent;
    expect(substitutes("i1")).toBe("or coconut oil (×1)");
    // Our Version holds none for i3, in place of the recipe's rice flour.
    expect(substitutes("i3")).toBeUndefined();
    // A line's substitutes change none of its text, and so don't mark it changed.
    expect(host.querySelector('[data-row="ingredients i1"]')?.textContent).not.toContain("Changed");
    act(() => button("Substitutes for 2 tbsp butter")?.click());
    expect(onOpen).toHaveBeenCalledWith({
      part: "ingredients",
      substitutesOf: "i1",
      title: "Substitutes for 2 tbsp butter",
    });
  });

  it("says how a changed step shows only once a step is changed", () => {
    const hint =
      "Changed steps show as you wrote them, without timers or scaled amounts, until enrichment runs.";
    const hints = () => [...host.querySelectorAll(".field-hint")].map((p) => p.textContent);
    const r = recipe();
    render(r);
    expect(hints()).not.toContain(hint);
    const draft = draftOf(r);
    const edit = { s1: { text: "Brown the butter.", component: null } };
    render(r, undefined, undefined, {
      ...draft,
      ours: { ...draft.ours, steps: { ...draft.ours.steps, edit } },
    });
    expect(hints()).toContain(hint);
  });

  it("moves the focus to the group's Add a line once an added line is removed", () => {
    const r = recipe();
    const start = ourDraftOf(r);
    const lemon = {
      id: "new-1",
      after: "i1",
      quantity: { low: 1, high: 1 },
      unit: null,
      name: "lemon",
      preparation: null,
      fdc_id: null,
      portion_id: null,
      component: null,
    };
    function Fields() {
      const [draft, setDraft] = useState<OurDraft>({
        ...start,
        ingredients: { ...start.ingredients, add: [lemon] },
      });
      return (
        <OurVersionFields
          recipe={r}
          draft={draft}
          collection={collection}
          onChange={setDraft}
          onOpen={() => {}}
        />
      );
    }
    act(() => root.render(<Fields />));
    const remove = button("Remove 1 lemon");
    remove?.focus();
    act(() => remove?.click());
    expect(button("Remove 1 lemon")).toBeUndefined();
    expect(document.activeElement?.textContent).toBe("Add a line");
  });

  it("moves the focus to the Add of the removed line's own group, not one with its heading", () => {
    // Unnamed lines, then the glaze, then unnamed lines again: two groups with no heading.
    const base = recipe();
    const r = recipe({
      original: {
        ...base.original,
        ingredients: base.original.ingredients.map((l) =>
          l.id === "i2" ? { ...l, component: "For the glaze" } : l,
        ),
      },
    });
    const start = ourDraftOf(r);
    const lemon = {
      id: "new-1",
      after: "i3",
      quantity: { low: 1, high: 1 },
      unit: null,
      name: "lemon",
      preparation: null,
      fdc_id: null,
      portion_id: null,
      component: null,
    };
    function Fields() {
      const [draft, setDraft] = useState<OurDraft>({
        ...start,
        ingredients: { ...start.ingredients, add: [lemon] },
      });
      return (
        <OurVersionFields
          recipe={r}
          draft={draft}
          collection={collection}
          onChange={setDraft}
          onOpen={() => {}}
        />
      );
    }
    act(() => root.render(<Fields />));
    const remove = button("Remove 1 lemon");
    remove?.focus();
    act(() => remove?.click());
    const adds = [...host.querySelectorAll("button")].filter((b) => b.textContent === "Add a line");
    expect(adds).toHaveLength(2);
    expect(document.activeElement).toBe(adds[1]);
  });

  it("offers no Our Version on a Pending recipe", () => {
    render(recipe({ status: "pending" }));
    expect(host.querySelector(".our-version-field")).toBeNull();
  });

  const alerts = () => [...host.querySelectorAll('[role="alert"]')];

  it("shows the API's refusal of an Our Version line by that line", () => {
    const at = { part: "ingredients" as const, id: "i2" };
    render(recipe(), "The closest FDC food is needed", at);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]?.closest(".our-version-row")?.textContent).toContain("2 cloves garlic");
  });

  it("shows the refusal of a line the draft adds by that line", () => {
    const r = recipe();
    const draft = draftOf(r);
    const lemon = {
      id: "new-1",
      after: "i1",
      quantity: { low: 1, high: 1 },
      unit: null,
      name: "lemon",
      preparation: null,
      fdc_id: null,
      portion_id: null,
      component: null,
    };
    const ours = { ...draft.ours, ingredients: { ...draft.ours.ingredients, add: [lemon] } };
    const at = { part: "ingredients" as const, id: "new-1" };
    render(r, "Line new-1 needs a Canonical Ingredient choice", at, { ...draft, ours });
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]?.closest(".our-version-row")?.textContent).toContain("1 lemon");
    // The row says which line it is, so the refusal leaves out the draft's id.
    expect(alerts()[0]?.textContent).toBe("Needs a Canonical Ingredient choice");
  });

  it("keeps the line's id in a refusal shown under the form", () => {
    const at = { part: "ingredients" as const, id: "new-1" };
    render(recipe(), "Line new-1 needs a Canonical Ingredient choice", at);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]?.closest(".our-version-row")).toBeNull();
    expect(alerts()[0]?.textContent).toBe("Line new-1 needs a Canonical Ingredient choice");
  });

  it("shows the API's refusal of an Our Version step by that step", () => {
    const at = { part: "steps" as const, id: "s1" };
    render(recipe(), "Step s1 follows a step that isn't there", at);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]?.closest(".our-version-row")?.textContent).toContain("Melt the butter.");
    expect(alerts()[0]?.textContent).toBe("Follows a step that isn't there");
  });

  it("reads a colon-led refusal of a line without its id", () => {
    const at = { part: "ingredients" as const, id: "i1" };
    render(recipe(), "Line i1: food 999 is not in the FDC Snapshot", at);
    expect(alerts()[0]?.textContent).toBe("Food 999 is not in the FDC Snapshot");
  });

  it("reads a possessive refusal of a line as the line's", () => {
    const at = { part: "ingredients" as const, id: "i1" };
    render(recipe(), "Line i1's FDC portion gives nothing to convert it by", at);
    expect(alerts()[0]?.textContent).toBe("The line's FDC portion gives nothing to convert it by");
  });

  it("shows a refusal of no line under the form", () => {
    render(recipe(), "An edited recipe is at most 350000 bytes as JSON");
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]?.closest(".our-version-row")).toBeNull();
  });
});
