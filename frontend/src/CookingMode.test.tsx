// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Card, Recipe } from "./api/client";
import { isCookingModeOpen } from "./cookingMode";
import { RecipeScreen } from "./RecipeScreen";
import { recipe as reviewRecipe, stamp } from "./review.fixtures";
import { stepTicks } from "./stepTicks";
import { TimerDock } from "./TimerDock";
import { timers } from "./timers";

// Cooking mode, opened from the recipe page in a DOM: where it starts, what Next, Back, Finish and
// Close do to the Step ticks, the text size it keeps, and the recipe it holds while open.
const shown: { recipe?: Recipe } = {};
vi.mock("./collection", () => ({
  useCollection: () => ({
    state: "ready",
    value: { cards: [card], canonical_ingredients: [], kitchen_settings: { store_categories: [] } },
  }),
  useRecipe: () => ({ state: "ready", value: shown.recipe }),
  useSync: () => undefined,
}));
vi.mock("./session", () => ({
  useIsEditor: () => false,
  EditorOnly: () => null,
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
  schema_version: 1,
};

// s1 melts the butter (i1, 2 tbsp), s2 simmers for a duration, s3 uses nothing.
function cookRecipe(s1 = "Melt the butter."): Recipe {
  const r = reviewRecipe({
    status: "ready",
    issues: [],
    source: {
      kind: "website",
      url: "https://example.com/beans",
      site_name: "example.com",
      captured_at: "2026-11-01T00:00:00Z",
    },
  } as Partial<Recipe>);
  r.original.steps = [
    { id: "s1", text: s1, component: null },
    { id: "s2", text: "Simmer for 8-10 minutes.", component: null },
    { id: "s3", text: "Serve.", component: null },
  ];
  r.facts.steps.s2 = {
    segments: {
      ...stamp(true),
      segments: [
        { t: "text", v: "Simmer for " },
        { t: "duration", low_s: 480, high_s: 600, written: "8-10 minutes" },
        { t: "text", v: "." },
      ],
    },
    uses: { ...stamp(true), uses: [] },
  };
  if (s1 !== "Melt the butter.") r.facts.steps = {};
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
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  stepTicks.clear(card.id);
  localStorage.clear();
  for (const timer of timers.snapshot().timers) timers.cancel(timer.id);
  Reflect.deleteProperty(navigator, "wakeLock");
});

const page = () => (
  <MemoryRouter initialEntries={[`/recipes/${card.id}/synthetic-test-beans`]}>
    <Routes>
      <Route path="/recipes/:id/:slug?" element={<RecipeScreen />} />
    </Routes>
    <TimerDock />
  </MemoryRouter>
);

function open(recipe = cookRecipe()) {
  shown.recipe = recipe;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(page()));
}

const named = (b: Element) => b.getAttribute("aria-label") ?? b.textContent;
const find = (scope: ParentNode | null | undefined, name: string | RegExp) =>
  [...(scope?.querySelectorAll("button") ?? [])].find((b) =>
    typeof name === "string" ? named(b) === name : name.test(named(b) ?? ""),
  );
const pageButton = (name: string | RegExp) => {
  const found = find(host, name);
  if (!found) throw new Error(`No button ${name}`);
  return found;
};
const cooking = () => host.querySelector<HTMLDialogElement>("dialog.cooking");
const inCooking = (name: string | RegExp) => {
  const found = find(cooking(), name);
  if (!found) throw new Error(`No button ${name} in cooking mode`);
  return found;
};
const tap = (button: HTMLButtonElement) => act(() => button.click());
const cook = () => tap(pageButton(/^(Cook|Resume)$/));
const progress = () => cooking()?.querySelector(".cooking-progress-text")?.textContent;
const stepShown = () => cooking()?.querySelector(".cooking-step")?.textContent;
const ticks = () => [...stepTicks.snapshot(card.id)].sort();

describe("the Cook button", () => {
  it("reads Cook with no step ticked, and Resume once one of the recipe's steps is", () => {
    stepTicks.tick(card.id, "gone");
    open();
    expect(pageButton(/^(Cook|Resume)$/).textContent).toBe("Cook");
    act(() => stepTicks.tick(card.id, "s2"));
    expect(pageButton(/^(Cook|Resume)$/).textContent).toBe("Resume");
  });
});

describe("cooking mode", () => {
  it("opens at the first step without a Step tick, full screen", () => {
    stepTicks.tick(card.id, "s1");
    open();
    cook();
    expect(cooking()?.open).toBe(true);
    expect(progress()).toBe("Step 2 of 3");
    expect(stepShown()).toBe("Simmer for 8-10 minutes.");
  });

  it("opens at the first step without a tick even when a later step has one", () => {
    stepTicks.tick(card.id, "s1");
    stepTicks.tick(card.id, "s3");
    open();
    cook();
    expect(progress()).toBe("Step 2 of 3");
  });

  it("opens at step 1 when every step is ticked", () => {
    for (const id of ["s1", "s2", "s3"]) stepTicks.tick(card.id, id);
    open();
    cook();
    expect(progress()).toBe("Step 1 of 3");
  });

  it("ticks the step it leaves on Next, and not on Back", () => {
    open();
    cook();
    expect(progress()).toBe("Step 1 of 3");
    expect(inCooking("Back").disabled).toBe(true);
    tap(inCooking("Next"));
    expect(progress()).toBe("Step 2 of 3");
    expect(ticks()).toEqual(["s1"]);
    tap(inCooking("Back"));
    expect(progress()).toBe("Step 1 of 3");
    expect(ticks()).toEqual(["s1"]);
    tap(inCooking("Next"));
    expect(ticks()).toEqual(["s1"]);
  });

  it("finishes on the last step: ticks it, clears the recipe's ticks and closes", () => {
    stepTicks.tick(card.id, "s1");
    stepTicks.tick(card.id, "s2");
    open();
    cook();
    expect(progress()).toBe("Step 3 of 3");
    expect(find(cooking(), "Next")).toBeUndefined();
    tap(inCooking("Finish"));
    expect(cooking()).toBeNull();
    expect(ticks()).toEqual([]);
    expect(pageButton(/^(Cook|Resume)$/).textContent).toBe("Cook");
  });

  it("closes without finishing, keeping the ticks", () => {
    open();
    cook();
    tap(inCooking("Next"));
    tap(inCooking("Close"));
    expect(cooking()).toBeNull();
    expect(ticks()).toEqual(["s1"]);
    expect(pageButton(/^(Cook|Resume)$/).textContent).toBe("Resume");
    expect(document.activeElement).toBe(pageButton("Resume"));
  });

  it("closes on Escape, the dialog's own close, keeping the ticks", () => {
    open();
    cook();
    tap(inCooking("Next"));
    act(() => cooking()?.close());
    expect(cooking()).toBeNull();
    expect(isCookingModeOpen()).toBe(false);
    expect(ticks()).toEqual(["s1"]);
    expect(document.activeElement).toBe(pageButton("Resume"));
  });

  it("is marked open while shown, and closed after Close and when the page goes", () => {
    open();
    expect(isCookingModeOpen()).toBe(false);
    cook();
    expect(isCookingModeOpen()).toBe(true);
    tap(inCooking("Close"));
    expect(isCookingModeOpen()).toBe(false);
    cook();
    expect(isCookingModeOpen()).toBe(true);
    act(() => root?.unmount());
    root = undefined;
    expect(isCookingModeOpen()).toBe(false);
  });

  it("shows what the step uses with its amount, and a Timer for a duration", () => {
    open();
    cook();
    const uses = cooking()?.querySelector(".cooking-uses");
    expect(uses?.textContent).toContain("In this step");
    expect(uses?.querySelector(".ingredient-name")?.textContent).toBe("butter");
    expect(uses?.querySelector(".ingredient-amount")?.textContent).toBe("2 tbsp");
    expect(stepShown()).toBe("Melt 2 tbsp butter.");
    tap(inCooking("Next"));
    expect(cooking()?.querySelector(".cooking-uses")).toBeNull();
    expect(inCooking("Start a timer for 8-10 minutes")).toBeDefined();
  });

  it("shows the amounts with the Adjust choices made before it opened, and no Adjust", () => {
    open();
    tap(pageButton(/^Adjust/));
    tap(pageButton("2×"));
    tap(pageButton("Done"));
    cook();
    expect(stepShown()).toBe("Melt ¼ cup butter.");
    expect(find(cooking(), /^Adjust/)).toBeUndefined();
  });

  it("keeps a larger text size on this device", () => {
    open();
    cook();
    expect(inCooking("Larger text").getAttribute("aria-pressed")).toBe("false");
    tap(inCooking("Larger text"));
    expect(inCooking("Larger text").getAttribute("aria-pressed")).toBe("true");
    expect(cooking()?.classList.contains("cooking-large")).toBe(true);
    expect(localStorage.getItem("plateful.cookingTextSize")).toBe("large");
    tap(inCooking("Close"));
    cook();
    expect(inCooking("Larger text").getAttribute("aria-pressed")).toBe("true");
    tap(inCooking("Larger text"));
    expect(localStorage.getItem("plateful.cookingTextSize")).toBeNull();
  });

  it("says the screen may turn off where the browser can't keep it on", () => {
    open();
    cook();
    expect(cooking()?.querySelector(".cooking-screen")?.textContent).toBe("Screen may turn off");
  });

  it("keeps the screen on while open, and lets it go on Close", async () => {
    const sentinel = Object.assign(new EventTarget(), { release: vi.fn(async () => {}) });
    const request = vi.fn(async (_type: "screen") => sentinel);
    Object.defineProperty(navigator, "wakeLock", { value: { request }, configurable: true });
    open();
    cook();
    await act(async () => {});
    expect(request).toHaveBeenCalledWith("screen");
    expect(cooking()?.querySelector(".cooking-screen")?.textContent).toBe("Screen stays on");
    tap(inCooking("Close"));
    expect(sentinel.release).toHaveBeenCalled();
  });

  it("shows the Timers inside it while open, and back on the page after Close", () => {
    open();
    cook();
    tap(inCooking("Next"));
    tap(inCooking("Start a timer for 8-10 minutes"));
    const dock = document.querySelector(".timer-dock");
    expect(dock?.hidden).toBe(false);
    expect(cooking()?.contains(dock)).toBe(true);
    tap(inCooking("Close"));
    expect(document.querySelector(".timer-dock")?.closest("dialog")).toBeNull();
    expect(document.querySelectorAll(".timer-dock")).toHaveLength(1);
  });

  it("keeps the recipe it opened with when a newer version arrives", () => {
    open();
    cook();
    shown.recipe = { ...cookRecipe("Brown the butter."), version: 5 };
    act(() => root?.render(page()));
    expect(stepShown()).toBe("Melt 2 tbsp butter.");
    tap(inCooking("Close"));
    cook();
    expect(stepShown()).toBe("Brown the butter.");
  });
});
