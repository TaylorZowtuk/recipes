// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Card, Recipe } from "./api/client";
import { RecipeScreen } from "./RecipeScreen";
import { conversion, parse, recipe as reviewRecipe, stamp } from "./review.fixtures";

// The recipe page's Adjust choices, tapped through in a DOM: the sheet's scale and units, an
// ingredient's own unit, and the scale a Week Plan link starts at.
const shown: { recipe?: Recipe; editor: boolean } = { editor: false };
vi.mock("./collection", () => ({
  useCollection: () => ({
    state: "ready",
    value: {
      cards: [card, other],
      canonical_ingredients: [],
      kitchen_settings: { store_categories: [] },
    },
  }),
  useRecipe: () => ({ state: "ready", value: shown.recipe }),
  useSync: () => undefined,
}));
vi.mock("./session", () => ({
  useIsEditor: () => shown.editor,
  EditorOnly: ({ children }: { children: unknown }) => (shown.editor ? children : null),
}));
vi.mock("./online", () => ({ useOnline: () => true }));
vi.mock("./AccountMenu", () => ({ AccountMenu: () => null }));
vi.mock("./weeks", () => ({}));
vi.mock("./timerSound", () => ({ unlockSound: () => {}, ring: () => {} }));

const card: Card = {
  id: "01K7TEST000000000000000001",
  title: "Synthetic Test Beans",
  site_name: "example.com",
  stated_seconds: null,
  status: "ready",
  preview: null,
  difficulty: null,
  difficulty_suggested: false,
  tags: [],
  needs_review: { open_issues: 0, unconfirmed: 0, flagged: 0 },
  recipe_version: 1,
  host: null,
  our_version_status: null,
  schema_version: 1,
};

const other: Card = { ...card, id: "01K7TEST000000000000000002", title: "Synthetic Other Beans" };

// Moves the router the test renders, as a link would, and notes the location it is at.
let go: (path: string) => void = () => {};
let at = "";
function Navigator() {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  at = pathname + search;
  go = (path) => {
    navigate(path);
  };
  return null;
}

// Butter (i1) weighs: its conversion is confirmed at the Confidence Threshold. Garlic (i2) has no
// weight per clove. Flour (i3) is 2 cups. Step s1 melts the butter; s2 heats the oven to 425°F.
function adjustRecipe(status: Recipe["status"] = "ready"): Recipe {
  const r = reviewRecipe({
    status,
    issues: [],
    source: {
      kind: "website",
      url: "https://example.com/beans",
      site_name: "example.com",
      captured_at: "2026-11-01T00:00:00Z",
    },
  } as Partial<Recipe>);
  const ingredients = r.facts.ingredients;
  ingredients.i1 = {
    ...ingredients.i1!,
    conversion: conversion(true, { density_g_per_ml: 0.96 }) as never,
  };
  r.original.steps = [
    { id: "s1", text: "Melt the butter.", component: null },
    { id: "s2", text: "Heat the oven to 425°F.", component: null },
  ];
  r.facts.steps.s2 = {
    segments: {
      ...stamp(true),
      segments: [
        { t: "text", v: "Heat the oven to " },
        { t: "temperature", c: 218, written: "425°F" },
        { t: "text", v: "." },
      ],
    },
    uses: { ...stamp(true), uses: [] },
  };
  return r;
}

let root: Root | undefined;
let host: HTMLDivElement;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
});

afterEach(() => {
  act(() => root?.unmount());
  host.remove();
  shown.editor = false;
});

function open(
  search = "",
  status: Recipe["status"] = "ready",
  slug = "synthetic-test-beans",
  ourVersion: Recipe["our_version"] = null,
) {
  shown.recipe = { ...adjustRecipe(status), our_version: ourVersion };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <MemoryRouter initialEntries={[`/recipes/${card.id}/${slug}${search}`]}>
        <Navigator />
        <Routes>
          <Route path="/recipes/:id/:slug?" element={<RecipeScreen />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}

const button = (name: string | RegExp) => {
  const found = [...host.querySelectorAll("button")].find((b) =>
    typeof name === "string"
      ? (b.getAttribute("aria-label") ?? b.textContent) === name
      : name.test(b.getAttribute("aria-label") ?? b.textContent ?? ""),
  );
  if (!found) throw new Error(`No button ${name}`);
  return found;
};
const tap = (name: string | RegExp) => act(() => button(name).click());
// Each ingredient line's amount, by the line's name.
const amount = (name: string) =>
  [...host.querySelectorAll(".ingredients li")]
    .find((li) => li.querySelector(".ingredient-name")?.textContent?.startsWith(name))
    ?.querySelector(".ingredient-amount")?.textContent;
const lineOf = (name: string) =>
  [...host.querySelectorAll(".ingredients li")].find((li) =>
    li.querySelector(".ingredient-name")?.textContent?.startsWith(name),
  );
// Each step's text, without the number beside it.
const steps = () =>
  [...host.querySelectorAll(".steps li")].map(
    (li) => (li.querySelector(".step-body") ?? li).textContent,
  );

describe("the Adjust sheet", () => {
  it("scales the ingredients and steps, and shows the choice on its button", () => {
    open();
    expect(amount("flour")).toBe("2 cups");
    tap(/^Adjust/);
    expect(host.querySelector("dialog")?.open).toBe(true);
    tap("2×");
    expect(button("2×").getAttribute("aria-pressed")).toBe("true");
    expect(button("1×").getAttribute("aria-pressed")).toBe("false");
    expect(amount("flour")).toBe("4 cups");
    expect(steps()[0]).toBe("Melt ¼ cup butter.");
    expect(button(/^Adjust/).textContent).toContain("2×");
  });

  it("shows the amounts and temperatures in the unit system chosen", () => {
    open();
    expect(steps()[1]).toBe("Heat the oven to 425°F.");
    tap(/^Adjust/);
    tap("Metric");
    expect(button("Metric").getAttribute("aria-pressed")).toBe("true");
    expect(amount("flour")).toBe("473 ml");
    expect(steps()[1]).toBe("Heat the oven to 220°C.");
    expect(button(/^Adjust/).textContent).toContain("Metric");
    tap("US");
    expect(amount("flour")).toBe("2 cups");
    tap("As written");
    expect(button(/^Adjust/).textContent).toBe("Adjust");
  });
});

describe("the Adjust choices", () => {
  it("are forgotten on leaving the recipe", () => {
    open();
    tap(/^Adjust/);
    tap("2×");
    tap("Metric");
    tap(/butter, show in another unit$/);
    expect(amount("butter")).toBe("¼ cup");
    const asWritten = () => {
      expect(button(/^Adjust/).textContent).toBe("Adjust");
      expect(amount("flour")).toBe("2 cups");
      expect(amount("butter")).toBe("2 tbsp");
    };
    act(() => go(`/recipes/${other.id}/synthetic-other-beans`));
    asWritten();
    act(() => go(`/recipes/${card.id}/synthetic-test-beans`));
    asWritten();
  });
});

describe("a Pending recipe", () => {
  it("shows Adjust disabled, with a note saying why", () => {
    open("", "pending");
    const adjust = button(/^Adjust/);
    expect(adjust.disabled).toBe(true);
    const note = document.getElementById(adjust.getAttribute("aria-describedby") ?? "");
    expect(note?.textContent).toBe("Scaling and units are ready once this recipe is enriched");
  });

  it("ignores a Week Plan link's scale", () => {
    open("?scale=2", "pending");
    expect(amount("flour")).toBe("2 cups");
    expect(button(/^Adjust/).textContent).toBe("Adjust");
  });

  it("leaves Adjust as it is on an Awaiting Review recipe", () => {
    open("?scale=2", "awaiting_review");
    expect(button(/^Adjust/).disabled).toBe(false);
    expect(button(/^Adjust/).getAttribute("aria-describedby")).toBeNull();
    expect(amount("flour")).toBe("4 cups");
  });
});

describe("a tap on an ingredient's amount", () => {
  it("cycles that ingredient's unit, and its steps follow", () => {
    open();
    tap(/^2 tbsp butter/);
    expect(amount("butter")).toBe("≈ 28 g");
    expect(steps()[0]).toBe("Melt ≈ 28 g butter.");
    tap(/^≈ 28 g butter/);
    expect(amount("butter")).toBe("≈ 1 oz");
    tap(/^≈ 1 oz butter/);
    expect(amount("butter")).toBe("2 tbsp");
  });

  it("is cleared by a change of units", () => {
    open();
    tap(/^2 tbsp butter/);
    expect(amount("butter")).toBe("≈ 28 g");
    tap(/^Adjust/);
    tap("US");
    expect(amount("butter")).toBe("2 tbsp");
  });

  it("reads out the new amount", () => {
    open();
    tap(/^2 tbsp butter/);
    const live = lineOf("butter")?.querySelector("[aria-live=polite]");
    expect(live?.textContent).toBe("≈ 28 g");
    expect(lineOf("butter")?.querySelector(".ingredient-why")).toBeNull();
  });

  it("says why an ingredient with no weight stays in its unit", () => {
    open();
    tap("2 cloves garlic, why it stays in this unit");
    const live = lineOf("garlic")?.querySelector("[aria-live=polite]");
    expect(live?.textContent).toBe("2 cloves. No weight known for this ingredient yet");
    expect(lineOf("garlic")?.querySelector(".ingredient-why")?.textContent).toBe(
      "No weight known for this ingredient yet",
    );
    expect(amount("garlic")).toBe("2 cloves");
  });

  it("reads out nothing more once the Adjust choices change", () => {
    open();
    tap(/^2 tbsp butter/);
    const live = () => lineOf("butter")?.querySelector("[aria-live=polite]")?.textContent;
    expect(live()).toBe("≈ 28 g");
    tap(/^Adjust/);
    tap("US");
    expect(live()).toBe("");
    tap("2×");
    expect(live()).toBe("");
  });

  it("stays silent when the Adjust choices change and change back", () => {
    open();
    tap(/^2 tbsp butter/);
    const region = () => lineOf("butter")?.querySelector("[aria-live=polite]");
    expect(region()?.getAttribute("aria-atomic")).toBe("true");
    expect(region()?.textContent).toBe("≈ 28 g");
    tap(/^Adjust/);
    tap("US");
    tap("As written");
    expect(region()?.textContent).toBe("");
  });

  it("reads out why again on a second tap", () => {
    open();
    const why = "2 cloves garlic, why it stays in this unit";
    const live = () => lineOf("garlic")?.querySelector("[aria-live=polite]")?.textContent;
    tap(why);
    const first = live();
    tap(why);
    expect(live()).toContain("No weight known for this ingredient yet");
    expect(live()).not.toBe(first);
  });

  it("says why a volume with no weight can't be a weight, as it cycles", () => {
    open();
    tap(/^Adjust/);
    tap("Metric");
    tap("473 ml flour, show in another unit");
    expect(amount("flour")).toBe("2 cups");
    const live = lineOf("flour")?.querySelector("[aria-live=polite]");
    expect(live?.textContent).toBe("2 cups. No weight known for this ingredient yet");
  });

  it("is plain text in a Review Item, never a button in a button", () => {
    shown.editor = true;
    open();
    for (const b of host.querySelectorAll("button")) expect(b.querySelector("button")).toBeNull();
  });
});

describe("a Week Plan link's scale", () => {
  it("starts the recipe at that scale", () => {
    open("?scale=1.5");
    expect(amount("flour")).toBe("3 cups");
    tap(/^Adjust/);
    expect(button("1½×").getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps its scale when an old title's address moves to the current one", () => {
    open("?scale=1.5", "ready", "old-title");
    expect(at).toBe(`/recipes/${card.id}/synthetic-test-beans?scale=1.5`);
    expect(amount("flour")).toBe("3 cups");
  });

  it("starts at 1× when it isn't one of the scales", () => {
    for (const scale of ["4", "abc", "0"]) {
      open(`?scale=${scale}`);
      expect(amount("flour")).toBe("2 cups");
      act(() => root?.unmount());
      host.remove();
    }
    open();
  });
});

// Less butter (i1 at 1 tbsp), no garlic (i2), a lemon added after the butter, and the oven lower.
const ourFacts = (name: string, quantity: number, unit: string | null) => ({
  parse: {
    ...parse(name, true, unit),
    provenance: "editor" as const,
    quantity: { low: quantity, high: quantity },
  },
  match: null,
  conversion: null,
  substitutions: null,
});
const OUR_VERSION: Recipe["our_version"] = {
  ingredients: {
    edit: { i1: { text: "1 tbsp butter", component: null } },
    remove: ["i2"],
    add: [{ id: "i5", after: "i1", text: "1 lemon", component: null }],
  },
  steps: {
    edit: { s2: { text: "Heat the oven to 400°F.", component: null } },
    remove: [],
    add: [],
  },
  facts: {
    ingredients: { i1: ourFacts("butter", 1, "tbsp"), i5: ourFacts("lemon", 1, null) },
    steps: {},
    difficulty: null,
  },
  note: "Less butter, and a lemon.",
  edited_at: "2026-11-02T00:00:00Z",
  last_line: 5,
  last_step: 0,
};
const names = () =>
  [...host.querySelectorAll(".ingredients .ingredient-name")].map((name) => name.textContent);
const notes = () => [...host.querySelectorAll(".our-version-note")].map((note) => note.textContent);
const tab = (name: string) =>
  act(() =>
    [...host.querySelectorAll<HTMLElement>('[role="tab"]')]
      .find((t) => t.textContent?.startsWith(name))
      ?.click(),
  );

describe("Our Version", () => {
  it("shows by default, marking what it changed, with its note in About", () => {
    open("", "ready", undefined, OUR_VERSION);
    expect(names()).toEqual(["butter", "lemon", "flour"]);
    expect(amount("butter")).toBe("1 tbsp");
    expect(notes()).toEqual(["was 2 tbsp", "added in Our Version", "changed in Our Version"]);
    expect(steps()).toEqual([
      "Melt 1 tbsp butter.",
      "Heat the oven to 400°F.changed in Our Version",
    ]);
    tab("About");
    expect(host.textContent).toContain("Less butter, and a lemon.");
  });

  it("switches to the Original in the Adjust sheet, with no marks or note", () => {
    open("", "ready", undefined, OUR_VERSION);
    tap(/^Adjust/);
    expect(button("Our Version").getAttribute("aria-pressed")).toBe("true");
    tap("Original");
    expect(names()).toEqual(["butter", "garlic", "flour"]);
    expect(amount("butter")).toBe("2 tbsp");
    expect(notes()).toEqual([]);
    expect(button(/^Adjust/).textContent).toBe("Adjust · Original");
    tab("About");
    expect(host.textContent).not.toContain("Less butter, and a lemon.");
  });

  it("keeps the scale and units when the version changes", () => {
    open("?scale=2", "ready", undefined, OUR_VERSION);
    tap(/^Adjust/);
    tap("Metric");
    tap("Original");
    expect(button("2×").getAttribute("aria-pressed")).toBe("true");
    expect(button("Metric").getAttribute("aria-pressed")).toBe("true");
  });

  it("offers no version choice for a recipe without Our Version", () => {
    open();
    tap(/^Adjust/);
    expect(() => button("Original")).toThrow();
  });

  it("never opens an Original line's Review Item from an Our Version line", () => {
    shown.editor = true;
    open("", "awaiting_review", undefined, OUR_VERSION);
    const butter = lineOf("butter");
    expect(butter?.querySelector("button")).toBeNull();
    expect(lineOf("flour")?.querySelector(".review-item")).not.toBeNull();
  });
});
