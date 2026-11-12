// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type Collection, type FdcFood, type Recipe } from "./api/client";
import { normalizeWording } from "./factEdits";
import { ItemEditForm } from "./ItemEditForm";
import { reviewOf } from "./review";
import {
  BUTTER,
  collection,
  GARLIC,
  KNOWN_CANONICAL,
  NEW_CANONICAL,
  recipe,
} from "./review.fixtures";

// FDC Snapshot foods as the search answers with them.
const portion = (id: number, amount: number, unit: string, gram_weight: number) => ({
  modifier: null as string | null,
  id,
  amount,
  unit,
  gram_weight,
});
const SALTED: FdcFood = {
  fdc_id: BUTTER.fdcId,
  description: "Butter, salted",
  dataset: "sr_legacy" as const,
  portions: [portion(BUTTER.tbsp, 1, "tbsp", 14.2), portion(BUTTER.cup, 1, "cup", 227)],
};
const UNSALTED: FdcFood = {
  fdc_id: 173430,
  description: "Butter, without salt",
  dataset: "sr_legacy" as const,
  portions: [{ ...portion(92512, 1, "tbsp", 14.2), modifier: "melted" }],
};
const GHEE: FdcFood = {
  fdc_id: 171314,
  description: "Butter, Clarified butter (ghee)",
  dataset: "sr_legacy" as const,
  portions: [],
};
const FOUND: Record<string, FdcFood[]> = {
  butter: [SALTED, UNSALTED],
  "butter without": [UNSALTED],
  ghee: [GHEE],
  garlic: [],
};

describe("an edit form, as an editor uses it", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: Root;
  let host: HTMLDivElement;
  const onSave = vi.fn(async () => null);
  const search = vi.spyOn(api, "GET");
  const searched = () =>
    (search.mock.calls as unknown as [string, { params: { query: { q: string } } }][]).map(
      ([, options]) => options.params.query.q,
    );
  beforeEach(() => {
    onSave.mockClear();
    search.mockReset();
    search.mockImplementation((async (
      _path: string,
      options: { params: { query: { q: string } } },
    ) => ({
      data: FOUND[options.params.query.q] ?? [],
      response: new Response(null, { status: 200 }),
    })) as never);
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
  // Lets the food search's pause pass and its answer arrive.
  const settle = () => act(() => new Promise((done) => setTimeout(done, 400)));
  const checked = () =>
    [...host.querySelectorAll(".choice")]
      .filter((c) => c.querySelector("input")?.checked)
      .map((c) => c.textContent);

  it("starts with the line's food and portion, named from a search for its Canonical Ingredient", async () => {
    open("i1");
    expect(field("Find an FDC food").value).toBe("butter");
    await settle();
    expect(searched()).toEqual(["butter"]);
    expect(checked()).toEqual([
      "Keep butter",
      "Butter, salted · SR Legacy",
      "1 tbsp (14.2 g)",
      "Convert to a weight",
    ]);
    expect(choice("Butter, without salt · SR Legacy")?.checked).toBe(false);
    expect(choice("1 cup (227 g)")?.checked).toBe(false);
    expect(choice("No portion")?.checked).toBe(false);
    await click(button("Save"));
    expect(saved()).toEqual([
      expect.objectContaining({ fdc_id: BUTTER.fdcId, portion_id: BUTTER.tbsp }),
    ]);
  });

  it("saves a food and portion picked from the search, or no portion", async () => {
    open("i1");
    await settle();
    type("Find an FDC food", "butter without");
    await settle();
    expect(searched()).toEqual(["butter", "butter without"]);
    // The line's own food stays offered beside what the search found.
    expect(choice("Butter, salted · SR Legacy")?.checked).toBe(true);
    await click(choice("Butter, without salt · SR Legacy") as HTMLInputElement);
    expect(choice("No portion")?.checked).toBe(true);
    await click(choice("1 tbsp, melted (14.2 g)") as HTMLInputElement);
    await click(button("Save"));
    await click(choice("No portion") as HTMLInputElement);
    await click(button("Save"));
    expect(saved()).toEqual([
      expect.objectContaining({ fdc_id: 173430, portion_id: 92512 }),
      expect.objectContaining({ fdc_id: 173430, portion_id: null }),
    ]);
  });

  it("searches only once typing pauses, and only for at least 2 characters", async () => {
    open("i1");
    type("Find an FDC food", "g");
    type("Find an FDC food", "gh");
    type("Find an FDC food", "ghee");
    await settle();
    expect(searched()).toEqual(["ghee"]);
    type("Find an FDC food", "x");
    await settle();
    expect(searched()).toEqual(["ghee"]);
  });

  it("takes the food of a line matched to the chosen Canonical Ingredient, without its portion", async () => {
    open("i1");
    await settle();
    type("Find or create one", "garlic");
    await click(choice("garlic") as HTMLInputElement);
    expect(field("Find an FDC food").value).toBe("garlic");
    await settle();
    // The search didn't find it, so it shows by its FDC id.
    expect(choice(`FDC food ${GARLIC.fdcId}`)?.checked).toBe(true);
    expect(choice("No portion")?.checked).toBe(true);
    await click(button("Save"));
    expect(saved()).toEqual([
      expect.objectContaining({
        canonical: { kind: "existing", id: KNOWN_CANONICAL },
        fdc_id: GARLIC.fdcId,
        portion_id: null,
      }),
    ]);
  });

  it("searches for a new Canonical Ingredient's food by its name, and won't save without one", async () => {
    open("i1");
    type("Find or create one", "ghee");
    await click(choice("New: ghee") as HTMLInputElement);
    type("Family", "dairy");
    await click(choice("Dairy & Eggs") as HTMLInputElement);
    expect(field("Find an FDC food").value).toBe("ghee");
    await settle();
    expect(choice("Butter, Clarified butter (ghee) · SR Legacy")?.checked).toBe(false);
    expect(choice("Butter, salted · SR Legacy")).toBeUndefined();
    await click(button("Save"));
    expect(onSave).not.toHaveBeenCalled();
    const problem = host.querySelector('[role="alert"]');
    expect(problem?.textContent).toBe(
      "Choose an FDC food for this line: the closest one if none fits.",
    );
    expect(field("Find an FDC food").getAttribute("aria-invalid")).toBe("true");
    await click(choice("Butter, Clarified butter (ghee) · SR Legacy") as HTMLInputElement);
    await click(button("Save"));
    expect(saved()).toEqual([expect.objectContaining({ fdc_id: 171314, portion_id: null })]);
  });

  it("says plainly when the search fails, keeping the line's food to choose", async () => {
    search.mockRejectedValue(new TypeError("offline"));
    open("i1");
    await settle();
    expect(host.textContent).toContain("Couldn’t search the FDC foods. Check you’re online.");
    expect(choice(`FDC food ${BUTTER.fdcId}`)?.checked).toBe(true);
    expect(choice("Current portion")?.checked).toBe(true);
    await click(button("Save"));
    expect(saved()).toEqual([
      expect.objectContaining({ fdc_id: BUTTER.fdcId, portion_id: BUTTER.tbsp }),
    ]);
  });

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
    const said = "Every line worded like this one, in every recipe, will use butter.";
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

  // Choosing it again is how an editor retries the recipes an earlier fan-out couldn't update.
  it("offers the line's current Canonical Ingredient beside Keep, saying what choosing it reaches", async () => {
    open("i1");
    expect(choice("Keep butter")?.checked).toBe(true);
    expect(choice("butter")?.checked).toBe(false);
    expect(host.querySelector('[role="status"]')?.textContent).toBe("");
    const current = choice("butter");
    if (!current) throw new Error("no current choice");
    await click(current);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "Every line worded like this one, in every recipe, will use butter.",
    );
    await click(button("Save"));
    expect(saved()).toEqual([
      expect.objectContaining({
        name: "butter",
        canonical: { kind: "existing", id: NEW_CANONICAL },
      }),
    ]);
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

  // A focused field scrolls clear of the whole foot, which a note or a problem makes taller.
  it("keeps the foot's height in --sheet-foot, and stops watching it once closed", () => {
    const watched: { foot: Element; disconnected: boolean }[] = [];
    let measure = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        #seen: (typeof watched)[number] | undefined;
        constructor(callback: () => void) {
          measure = callback;
        }
        observe(foot: Element) {
          this.#seen = { foot, disconnected: false };
          watched.push(this.#seen);
        }
        disconnect() {
          if (this.#seen) this.#seen.disconnected = true;
        }
      },
    );
    try {
      open("i1", { note: "You’re offline." });
      const foot = host.querySelector(".sheet-actions");
      expect(watched.map((w) => w.foot)).toEqual([foot]);
      Object.defineProperty(foot, "offsetHeight", { value: 131 });
      act(() => measure());
      const form = host.querySelector<HTMLElement>(".item-edit");
      expect(form?.style.getPropertyValue("--sheet-foot")).toBe("131px");
      act(() => root.render(null));
      expect(watched[0]?.disconnected).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("saves a step's portions by their order, keeping those not changed", async () => {
    const r = recipe();
    const s1 = r.facts.steps.s1;
    if (!s1?.segments) throw new Error("fixture");
    const split = recipe({
      facts: {
        ...r.facts,
        steps: {
          s1: {
            ...s1,
            segments: {
              ...s1.segments,
              segments: [
                { t: "text", v: "Melt " },
                { t: "ingredient", ref: "i1", written: "half the butter", portion: 0.5 },
                { t: "text", v: ", then " },
                { t: "ingredient", ref: "i1", written: "a little more", portion: 0.13 },
                { t: "text", v: "." },
              ],
            },
          },
        },
      },
    });
    open("s1", { r: split });
    expect(field("“half the butter”, butter").value).toBe("½");
    // Shown as ⅛, the second portion, untouched, saves as its own stored 0.13, not as ⅛.
    expect(field("“a little more”, butter").value).toBe("⅛");
    type("“half the butter”, butter", "⅓");
    await click(button("Save"));
    expect(saved()).toEqual([
      { kind: "step", step_id: "s1", portions: [1 / 3, 0.13], durations: [] },
    ]);
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
    await click(button("Remove oat flour"));
    expect(saved()).toEqual([
      { kind: "substitution", line_id: "i3", index: 1, ratio: 1.5, note: "" },
      { kind: "remove_substitution", line_id: "i3", index: 1 },
    ]);
  });

  it("says why a substitute's Save and Remove are off, beside them", () => {
    open("i3.substitutions", { note: "You’re offline." });
    expect(host.querySelector(".sheet-actions")?.textContent).toContain("You’re offline.");
    for (const name of ["Save rice flour", "Remove rice flour"]) {
      const off = button(name);
      expect(off.disabled).toBe(true);
      const said = off.getAttribute("aria-describedby");
      expect(said && document.getElementById(said)?.textContent).toBe("You’re offline.");
    }
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
