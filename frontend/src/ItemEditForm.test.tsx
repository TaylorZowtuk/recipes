// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Collection, Recipe } from "./api/client";
import { normalizeWording } from "./factEdits";
import { ItemEditForm } from "./ItemEditForm";
import { reviewOf } from "./review";
import { collection, KNOWN_CANONICAL, NEW_CANONICAL, recipe } from "./review.fixtures";

describe("an edit form, as an editor uses it", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: Root;
  let host: HTMLDivElement;
  const onSave = vi.fn(async () => null);
  beforeEach(() => {
    onSave.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const open = (
    id: string,
    {
      r = recipe(),
      kitchen = collection,
      note,
    }: { r?: Recipe; kitchen?: Collection; note?: string } = {},
  ) => {
    const item = reviewOf(r).get(id);
    if (!item) throw new Error(`no item ${id}`);
    act(() =>
      root.render(
        <ItemEditForm
          item={item}
          recipe={r}
          collection={kitchen}
          disabled={!!note}
          note={note && <p className="screen-note">{note}</p>}
          onSave={onSave}
          onCancel={() => {}}
        />,
      ),
    );
  };
  const field = (label: string) => {
    const shown = [...host.querySelectorAll("label")].find((l) => l.textContent === label);
    const input = shown && document.getElementById(shown.htmlFor);
    if (!(input instanceof HTMLInputElement)) throw new Error(`no field ${label}`);
    return input;
  };
  const type = (label: string, value: string) =>
    act(() => {
      const input = field(label);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const button = (name: string, n = 0) => {
    const found = [...host.querySelectorAll("button")].filter(
      (b) => b.textContent?.replace(/\s+/g, " ").trim() === name,
    )[n];
    if (!found) throw new Error(`no button ${name}`);
    return found;
  };
  const click = async (element: HTMLElement) => {
    await act(async () => element.click());
  };
  const choice = (name: string) =>
    [...host.querySelectorAll(".choice")]
      .find((c) => c.textContent === name)
      ?.querySelector("input");
  const saved = () => (onSave.mock.calls as unknown as [unknown][]).map(([edit]) => edit);

  it("normalizes a wording as the Wording Cache does", () => {
    expect(normalizeWording("  Salted   BUTTER, ")).toBe("salted butter");
    expect(normalizeWording("(butter)")).toBe("butter");
  });

  it("asks for a Canonical Ingredient once the name's wording changes, picking the current one", async () => {
    open("i1");
    expect(choice("Keep butter")).toBeTruthy();
    type("Name", "Butter.");
    expect(choice("Keep butter")).toBeTruthy();
    type("Name", "salted butter");
    expect(choice("Keep butter")).toBeUndefined();
    expect(choice("butter")?.checked).toBe(true);
    const note = host.querySelector('[role="status"]');
    const said = "Every line with this line’s wording, in every recipe, will use butter.";
    expect(note?.textContent).toBe(said);
    // Typing on doesn't change it, so it's announced only when the pick changes.
    type("Name", "salted butter cubes");
    expect(host.querySelector('[role="status"]')?.textContent).toBe(said);
    type("Name", "salted butter");
    await click(button("Save"));
    expect(saved()).toEqual([
      expect.objectContaining({
        name: "salted butter",
        canonical: { kind: "existing", id: NEW_CANONICAL },
      }),
    ]);

    // Named back, Keep is there again, and chosen.
    type("Name", "butter");
    expect(choice("Keep butter")?.checked).toBe(true);
    await click(button("Save"));
    expect(saved()[1]).not.toHaveProperty("canonical");
  });

  it("says what a pick reaches under the choices, not over the fields at the sheet's foot", () => {
    open("i1");
    type("Name", "salted butter");
    const note = host.querySelector('[role="status"]');
    expect(note?.previousElementSibling?.classList.contains("choices")).toBe(true);
    expect(note?.closest("fieldset")?.querySelector("legend")?.textContent).toBe(
      "Canonical Ingredient",
    );
    expect(host.querySelector(".sheet-actions")?.textContent).toBe("CancelSave");
  });

  it("picks the new wording's confirmed Wording Cache entry when the Collection has one", async () => {
    const kitchen = {
      ...collection,
      wordings: [
        {
          wording: "garlic butter",
          canonical_id: KNOWN_CANONICAL,
          confirmed: true,
          schema_version: 1,
        },
      ],
    } as Collection;
    open("i1", { kitchen });
    type("Name", "Garlic  butter");
    expect(choice("garlic")?.checked).toBe(true);
    await click(button("Save"));
    expect(saved()).toEqual([
      expect.objectContaining({ canonical: { kind: "existing", id: KNOWN_CANONICAL } }),
    ]);
  });

  it("ties a problem to the field at fault, and the amount hint to its fields", async () => {
    open("i1");
    const hint = field("Amount").getAttribute("aria-describedby");
    expect(hint && document.getElementById(hint.split(" ")[0] ?? "")?.textContent).toMatch(
      /^Such as 2/,
    );
    type("Amount", "lots");
    await click(button("Save"));
    const problem = host.querySelector('[role="alert"]');
    expect(problem?.textContent).toMatch(/^Give the amount as a number/);
    expect(field("Amount").getAttribute("aria-invalid")).toBe("true");
    expect(field("Amount").getAttribute("aria-describedby")).toContain(problem?.id);
    expect(field("Name").getAttribute("aria-invalid")).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("says why Save is off, beside it", () => {
    open("i1", { note: "You’re offline." });
    const actions = host.querySelector(".sheet-actions");
    expect(actions?.textContent).toContain("You’re offline.");
    const save = button("Save");
    expect(save.disabled).toBe(true);
    const said = save.getAttribute("aria-describedby");
    expect(said && document.getElementById(said)?.textContent).toBe("You’re offline.");
  });

  it("saves a step's portions and timers", async () => {
    open("s1");
    type("“the butter”, butter", "½");
    await click(button("Save"));
    expect(saved()).toEqual([{ kind: "step", step_id: "s1", portions: [0.5], durations: [] }]);
  });

  it("saves or removes each substitute by its index, and says each saves on its own", async () => {
    const r = recipe();
    const i3 = r.facts.ingredients.i3;
    if (!i3?.substitutions) throw new Error("fixture");
    const [rice] = i3.substitutions.items;
    if (!rice) throw new Error("fixture");
    const two = recipe({
      facts: {
        ...r.facts,
        ingredients: {
          ...r.facts.ingredients,
          i3: {
            ...i3,
            substitutions: {
              ...i3.substitutions,
              items: [rice, { ...rice, wording: "oat flour", ratio: 1, note: "" }],
            },
          },
        },
      },
    });
    open("i3.substitutions", { r: two });
    expect(host.textContent).toContain("Save each substitute on its own.");
    const ratios = [...host.querySelectorAll("form")].map((form) => form.querySelector("input"));
    act(() => {
      const input = ratios[1] as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "1½");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Save oat flour"));
    await click(button("Remove rice flour"));
    expect(saved()).toEqual([
      { kind: "substitution", line_id: "i3", index: 1, ratio: 1.5, note: "" },
      { kind: "remove_substitution", line_id: "i3", index: 0 },
    ]);
  });

  it("saves the Difficulty", async () => {
    open("difficulty");
    const three = host.querySelectorAll<HTMLInputElement>('input[name="difficulty-cleanup"]')[2];
    if (!three) throw new Error("no rating");
    await click(three);
    await click(button("Save"));
    expect(saved()).toEqual([{ kind: "difficulty", prep: 2, cook: 1, cleanup: 3 }]);
  });
});
