// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type Collection, type FdcFood, type Recipe } from "./api/client";
import { EDITOR_KEPT, normalizeWording } from "./factEdits";
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

// FDC Snapshot foods as the search answers with them: a portion in a volume gives a density.
const portion = (id: number, amount: number, unit: string, gram_weight: number) => ({
  modifier: null as string | null,
  id,
  amount,
  unit,
  gram_weight,
  density_g_per_ml: gram_weight / (amount * 14.79),
  grams_per_count: null as number | null,
  count_unit: null as string | null,
  fits: null as boolean | null,
});
const counted = (id: number, unit: string, gram_weight: number) => ({
  ...portion(id, 1, unit, gram_weight),
  density_g_per_ml: null,
  grams_per_count: gram_weight,
  count_unit: unit,
});
const SALTED: FdcFood = {
  fdc_id: BUTTER.fdcId,
  description: "Butter, salted",
  dataset: "sr_legacy" as const,
  portions: [
    portion(BUTTER.tbsp, 1, "tbsp", 14.2),
    portion(BUTTER.cup, 1, "cup", 227),
    counted(92459, "pat", 5),
  ],
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
const RAW_GARLIC: FdcFood = {
  fdc_id: GARLIC.fdcId,
  description: "Garlic, raw",
  dataset: "sr_legacy" as const,
  portions: [counted(GARLIC.clove, "clove", 3)],
};
// Two foods FDC describes alike.
const salt = (fdc_id: number): FdcFood => ({
  fdc_id,
  description: "Salt, table, iodized",
  dataset: "foundation" as const,
  portions: [],
});
const FOUND: Record<string, FdcFood[]> = {
  butter: [SALTED, UNSALTED],
  "butter without": [UNSALTED],
  ghee: [GHEE],
  garlic: [],
  salt: [salt(746775), salt(746776)],
};
const BY_ID = new Map([SALTED, UNSALTED, GHEE, RAW_GARLIC].map((f) => [f.fdc_id, f]));
type Query = {
  q: string;
  canonical?: string;
  fdc_id?: number;
  unit?: string;
  unit_kind?: string;
  amount?: boolean;
};
// The units the API says a portion fits, where it fits only some: the pat portion only pats.
const FITS_ONLY: Record<number, string[]> = { 92459: ["pats"] };
// What the API answers: a line matched to garlic elsewhere in the Collection gives its food as
// garlic's default, first, then the named food, then what the search found, each portion saying
// whether it fits the line's unit when the search names one. Any portion fits a line with no amount.
const answer = ({ q, canonical, fdc_id, unit, amount }: Query) => {
  const fallback = canonical === KNOWN_CANONICAL ? RAW_GARLIC : undefined;
  const named = [fallback, fdc_id === undefined ? undefined : BY_ID.get(fdc_id)];
  const foods = [...named, ...(FOUND[q] ?? [])].filter(
    (f, n, all): f is FdcFood => !!f && all.findIndex((g) => g?.fdc_id === f.fdc_id) === n,
  );
  const fits = (id: number) =>
    unit === undefined ? null : amount === false || (FITS_ONLY[id]?.includes(unit) ?? true);
  return {
    foods: foods.map((f) => ({
      ...f,
      portions: f.portions.map((p) => ({ ...p, fits: fits(p.id) })),
    })),
    default_fdc_id: fallback?.fdc_id ?? null,
  };
};

describe("an edit form, as an editor uses it", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: Root;
  let host: HTMLDivElement;
  const onSave = vi.fn(async () => null);
  const search = vi.spyOn(api, "GET");
  const queries = () =>
    (search.mock.calls as unknown as [string, { params: { query: Query } }][]).map(
      ([, options]) => options.params.query,
    );
  const searched = () => queries().map((query) => query.q);
  beforeEach(() => {
    onSave.mockClear();
    search.mockReset();
    search.mockImplementation((async (_path: string, options: { params: { query: Query } }) => ({
      data: answer(options.params.query),
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

  it("starts from the food the API gives for the chosen Canonical Ingredient, without a portion", async () => {
    open("i1");
    await settle();
    type("Find or create one", "garlic");
    await click(choice("garlic") as HTMLInputElement);
    expect(field("Find an FDC food").value).toBe("garlic");
    await settle();
    expect(queries().at(-1)).toEqual({
      q: "garlic",
      canonical: KNOWN_CANONICAL,
      fdc_id: BUTTER.fdcId,
      unit: "tbsp",
    });
    expect(choice("Garlic, raw · SR Legacy")?.checked).toBe(true);
    expect(choice("No portion")?.checked).toBe(true);
    // The line's own food stays offered, by its name.
    expect(choice("Butter, salted · SR Legacy")?.checked).toBe(false);
    // Only the first search asks for the default and the line's food.
    type("Find an FDC food", "ghee");
    await settle();
    expect(queries().at(-1)).toEqual({ q: "ghee", unit: "tbsp" });
    expect(choice("Garlic, raw · SR Legacy")?.checked).toBe(true);
    await click(button("Save"));
    expect(saved()).toEqual([
      expect.objectContaining({
        canonical: { kind: "existing", id: KNOWN_CANONICAL },
        fdc_id: GARLIC.fdcId,
        portion_id: null,
      }),
    ]);
  });

  it("names the line's food though the search doesn't find it", async () => {
    open("i2");
    await settle();
    expect(queries()).toEqual([{ q: "garlic", fdc_id: GARLIC.fdcId, unit: "cloves" }]);
    expect(checked()).toContain("Garlic, raw · SR Legacy");
    expect(checked()).toContain("1 clove (3 g)");
  });

  it("tells foods FDC describes alike apart by their FDC ids", async () => {
    open("i1");
    type("Find an FDC food", "salt");
    await settle();
    expect(choice("Salt, table, iodized · Foundation · FDC 746775")).toBeDefined();
    expect(choice("Salt, table, iodized · Foundation · FDC 746776")).toBeDefined();
  });

  it("hides the food for a line with no Canonical Ingredient, and saves it with none", async () => {
    open("i3");
    await settle();
    expect(searched()).toEqual([]);
    expect(host.textContent).not.toContain("FDC food");
    await click(button("Save"));
    expect(saved()).toEqual([expect.objectContaining({ fdc_id: null, portion_id: null })]);
  });

  it("keeps a kept line kept with a new food, offering to convert only by a portion", async () => {
    const r = recipe();
    const i1 = r.facts.ingredients.i1;
    if (!i1?.conversion) throw new Error("fixture");
    const kept = recipe({
      facts: {
        ...r.facts,
        ingredients: {
          ...r.facts.ingredients,
          i1: { ...i1, conversion: { ...i1.conversion, refused: EDITOR_KEPT } },
        },
      },
    });
    open("i1", { r: kept });
    await settle();
    expect(choice("Keep the written unit")?.checked).toBe(true);
    await click(choice("Butter, without salt · SR Legacy") as HTMLInputElement);
    expect(choice("No portion")?.checked).toBe(true);
    // No portion, so nothing to convert by.
    expect(choice("Convert to a weight")).toBeUndefined();
    await click(choice("1 tbsp, melted (14.2 g)") as HTMLInputElement);
    expect(choice("Keep the written unit")?.checked).toBe(true);
    await click(button("Save"));
    expect(saved()).toEqual([
      expect.objectContaining({ fdc_id: 173430, portion_id: 92512, keep_weight: true }),
    ]);
  });

  // The recipe with i1's tbsp read by the parser as a volume.
  const spoon = () => {
    const r = recipe();
    const i1 = r.facts.ingredients.i1;
    if (!i1?.parse) throw new Error("fixture");
    return recipe({
      facts: {
        ...r.facts,
        ingredients: {
          ...r.facts.ingredients,
          i1: { ...i1, parse: { ...i1.parse, unit_kind: "volume" } },
        },
      },
    });
  };

  it("says when the chosen portion doesn't fit the line's unit, without stopping the save", async () => {
    open("i1", { r: spoon() });
    await settle();
    // The API decides, by the parser's kind for the unit as it read it.
    expect(queries().at(-1)).toMatchObject({ unit: "tbsp", unit_kind: "volume" });
    expect(host.textContent).not.toContain("gets no weight");
    await click(choice("1 pat (5 g)") as HTMLInputElement);
    expect(host.textContent).toContain(
      "This portion is counted in pat, but the line is in tbsp, so the line gets no weight.",
    );
    await click(button("Save"));
    expect(saved()).toEqual([expect.objectContaining({ portion_id: 92459 })]);
  });

  it("says nothing of a portion the API says fits the line's unit", async () => {
    FITS_ONLY[92459] = ["tbsp"];
    try {
      open("i1", { r: spoon() });
      await settle();
      await click(choice("1 pat (5 g)") as HTMLInputElement);
      expect(host.textContent).not.toContain("gets no weight");
    } finally {
      FITS_ONLY[92459] = ["pats"];
    }
  });

  it("asks again whether the portion fits once the line's unit is edited", async () => {
    open("i1");
    await settle();
    await click(choice("1 pat (5 g)") as HTMLInputElement);
    expect(host.textContent).toContain("gets no weight");
    type("Unit", "pats");
    // Until the API answers for the new unit, it says nothing of the old one's.
    expect(host.textContent).not.toContain("gets no weight");
    await settle();
    expect(queries().at(-1)).toEqual({ q: "butter", unit: "pats" });
    expect(host.textContent).not.toContain("gets no weight");
    expect(choice("1 pat (5 g)")?.checked).toBe(true);
    type("Unit", "");
    await settle();
    expect(queries().at(-1)).toEqual({ q: "butter", unit: "" });
    expect(host.textContent).toContain(
      "This portion is counted in pat, but the line is a count with no unit, so the line gets no weight.",
    );
  });

  it("says nothing of the portion for a line with no amount, which no portion gives a weight", async () => {
    open("i1");
    await settle();
    await click(choice("1 pat (5 g)") as HTMLInputElement);
    expect(host.textContent).toContain("gets no weight");
    type("Amount", "");
    await settle();
    expect(queries().at(-1)).toEqual({ q: "butter", unit: "tbsp", amount: false });
    expect(host.textContent).not.toContain("gets no weight");
  });

  it("asks for the default and the line's food only in the picker's first answered search", async () => {
    open("i1", { r: spoon() });
    await settle();
    expect(queries()).toEqual([
      { q: "butter", fdc_id: BUTTER.fdcId, unit: "tbsp", unit_kind: "volume" },
    ]);
    type("Unit", "pats");
    await settle();
    type("Find an FDC food", "ghee");
    await settle();
    // Back to the start query, as the picker opened with.
    type("Find an FDC food", "butter");
    await settle();
    expect(queries().slice(1)).toEqual([
      { q: "butter", unit: "pats" },
      { q: "ghee", unit: "pats" },
      { q: "butter", unit: "pats" },
    ]);
  });

  it("asks again for the default while the first search has no answer", async () => {
    search.mockImplementationOnce((async () => ({
      error: "x",
      response: new Response(null, { status: 503 }),
    })) as never);
    open("i1");
    await settle();
    type("Find an FDC food", "ghee");
    await settle();
    expect(queries()).toEqual([
      { q: "butter", fdc_id: BUTTER.fdcId, unit: "tbsp" },
      { q: "ghee", fdc_id: BUTTER.fdcId, unit: "tbsp" },
    ]);
  });

  it("keeps the newer query's foods shown when an older search answers after it", async () => {
    let answerFirst = () => {};
    search.mockImplementationOnce(
      ((_path: string, options: { params: { query: Query } }) =>
        new Promise((done) => {
          answerFirst = () =>
            done({ data: answer(options.params.query), response: new Response(null) });
        })) as never,
    );
    open("i1");
    await settle();
    type("Find an FDC food", "ghee");
    await settle();
    expect(searched()).toEqual(["butter", "ghee"]);
    expect(choice("Butter, Clarified butter (ghee) · SR Legacy")).toBeDefined();
    await act(async () => answerFirst());
    await settle();
    expect(choice("Butter, Clarified butter (ghee) · SR Legacy")).toBeDefined();
    expect(choice("Butter, without salt · SR Legacy")).toBeUndefined();
  });

  const status = () =>
    [...host.querySelectorAll('[role="status"]')].map((s) => s.textContent).join(" ");

  it("announces how many foods the search found, never that it is searching", async () => {
    open("i1");
    type("Find an FDC food", "ghee");
    expect(host.textContent).toContain("Searching the FDC foods…");
    expect(status()).not.toContain("Searching");
    await settle();
    expect(status()).toContain("2 FDC foods found.");
    type("Find an FDC food", "butter without");
    await settle();
    expect(status()).toContain("1 FDC food found.");
    expect(status()).not.toContain("butter");
  });

  it("announces the default food when the picker chooses it", async () => {
    open("i1");
    await settle();
    type("Find or create one", "garlic");
    await click(choice("garlic") as HTMLInputElement);
    await settle();
    expect(status()).toContain(
      "2 FDC foods found. Chose Garlic, raw · SR Legacy, the food the Collection gives this Canonical Ingredient.",
    );
  });

  it("offers converting to a weight right after the portion that gives one", async () => {
    open("i1");
    await settle();
    const legends = [...host.querySelectorAll("legend")].map((l) => l.textContent);
    expect(legends.slice(legends.indexOf("Portion"))).toEqual(["Portion", "Weight"]);
    const weight = [...host.querySelectorAll("fieldset")].find(
      (f) => f.querySelector("legend")?.textContent === "Weight",
    );
    expect(weight?.parentElement?.closest("fieldset")?.querySelector("legend")?.textContent).toBe(
      "FDC food",
    );
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
    // The line's own food stays offered, but isn't chosen for the new one.
    expect(choice("Butter, salted · SR Legacy")?.checked).toBe(false);
    await click(button("Save"));
    expect(onSave).not.toHaveBeenCalled();
    const problem = host.querySelector('[role="alert"]');
    expect(problem?.textContent).toBe(
      "Choose an FDC food for this line: the closest one if none fits.",
    );
    expect(field("Find an FDC food").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(field("Find an FDC food"));
    await click(choice("Butter, Clarified butter (ghee) · SR Legacy") as HTMLInputElement);
    await click(button("Save"));
    expect(saved()).toEqual([expect.objectContaining({ fdc_id: 171314, portion_id: null })]);
  });

  it("says plainly when the search fails, keeping the line's food to choose", async () => {
    search.mockRejectedValue(new TypeError("offline"));
    open("i1");
    await settle();
    expect(host.textContent).toContain("Couldn’t search the FDC foods. Check you’re online.");
    expect(choice("The line’s current FDC food (its name loads when you’re online)")?.checked).toBe(
      true,
    );
    expect(choice("The line’s current portion")?.checked).toBe(true);
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
    await settle();
    await click(button("Save"));
    expect(saved()).toEqual([
      expect.objectContaining({
        canonical: { kind: "existing", id: KNOWN_CANONICAL },
        fdc_id: GARLIC.fdcId,
      }),
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
