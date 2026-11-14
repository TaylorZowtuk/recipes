import { describe, expect, it } from "vitest";
import { applyDemoOperations, demoWeek } from "./demoWeek";

const MONDAY = "2026-11-02";

const cards = ["A", "B", "C", "D", "E", "F", "G", "H"].map((letter) => ({
  id: `01K7TEST00000000000000000${letter}`,
  title: `Synthetic Dish ${letter}`,
}));

const entries = (plan: ReturnType<typeof demoWeek>) => plan.days.flat();

describe("demoWeek", () => {
  it("is the same plan for the same week", () => {
    expect(demoWeek(MONDAY, cards)).toEqual(demoWeek(MONDAY, cards));
  });

  it("differs from one week to the next", () => {
    expect(demoWeek("2026-11-09", cards).days).not.toEqual(demoWeek(MONDAY, cards).days);
  });

  it("doesn't depend on the Collection's order", () => {
    expect(demoWeek(MONDAY, [...cards].reverse())).toEqual(demoWeek(MONDAY, cards));
  });

  it("plans the week from the Collection, leaving some days free", () => {
    const plan = demoWeek(MONDAY, cards);
    expect(plan.week_start).toBe(MONDAY);
    expect(plan.days).toHaveLength(7);
    expect(plan.days.some((day) => day.length === 0)).toBe(true);
    expect(entries(plan).length).toBeGreaterThan(0);
    for (const entry of entries(plan)) {
      expect(cards).toContainEqual({ id: entry.recipe_id, title: entry.recipe_title });
      expect(entry.entry_id).toMatch(/^demo-2026-11-02-/);
    }
    expect(new Set(entries(plan).map((e) => e.entry_id)).size).toBe(entries(plan).length);
  });

  it("is an empty week for an empty Collection", () => {
    expect(entries(demoWeek(MONDAY, []))).toEqual([]);
  });
});

describe("applyDemoOperations", () => {
  const empty = demoWeek(MONDAY, []);
  const [noodles, oats] = cards as [(typeof cards)[0], (typeof cards)[0]];

  it("places a recipe at the end of its day, with a new entry and the card's title", () => {
    const once = applyDemoOperations(
      empty,
      [{ op: "place", day: 2, recipe_id: noodles.id }],
      cards,
    );
    const twice = applyDemoOperations(
      once,
      [{ op: "place", day: 2, recipe_id: oats.id, amount: { kind: "scale", factor: 2 } }],
      cards,
    );
    expect(twice.days[2]).toMatchObject([
      { recipe_id: noodles.id, recipe_title: noodles.title, amount: { factor: 1 } },
      { recipe_id: oats.id, recipe_title: oats.title, amount: { factor: 2 } },
    ]);
    expect(twice.days[2]?.[0]?.entry_id).not.toBe(twice.days[2]?.[1]?.entry_id);
    expect(empty.days[2]).toEqual([]);
  });

  it("rescales and removes an entry by its id", () => {
    const placed = applyDemoOperations(
      empty,
      [{ op: "place", day: 0, recipe_id: noodles.id }],
      cards,
    );
    const entryId = placed.days[0]?.[0]?.entry_id ?? "";
    const scaled = applyDemoOperations(
      placed,
      [{ op: "set_amount", entry_id: entryId, amount: { kind: "scale", factor: 0.5 } }],
      cards,
    );
    expect(scaled.days[0]?.[0]?.amount.factor).toBe(0.5);
    const removed = applyDemoOperations(scaled, [{ op: "remove", entry_id: entryId }], cards);
    expect(removed.days[0]).toEqual([]);
  });

  it("places nothing for a recipe not in the Collection", () => {
    const plan = applyDemoOperations(empty, [{ op: "place", day: 1, recipe_id: "gone" }], cards);
    expect(plan.days).toEqual(empty.days);
  });
});
