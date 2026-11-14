import type { Card, Factor, WeekOperation, WeekPlan, WeekPlanEntry } from "./api/client";

type DemoCard = Pick<Card, "id" | "title">;

// A small seeded generator (mulberry32), so a week's Demo is the same on every device and visit.
function random(seed: string): () => number {
  let state = 0;
  for (const char of seed) state = (Math.imul(state, 31) + char.charCodeAt(0)) | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ODD_SCALES: Factor[] = [0.5, 1.5, 2];

// A Fisher–Yates shuffle drawing from `next`, so the same seed gives the same order.
function shuffle<T>(items: T[], next: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

// The Demo Week Plan for the week starting `monday`: one to three days free, the others one
// recipe, now and then two, mostly at 1×. Recipes go round in a shuffled order, so a week rarely
// repeats one.
export function demoWeek(monday: string, cards: DemoCard[]): WeekPlan {
  const next = random(monday);
  const sorted = [...cards].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const order = shuffle(sorted, next);
  const free = new Set(shuffle([0, 1, 2, 3, 4, 5, 6], next).slice(0, 1 + Math.floor(next() * 3)));
  let count = 0;
  const entry = (): WeekPlanEntry => {
    const card = order[count % order.length] as DemoCard;
    const factor = next() < 0.8 ? 1 : (ODD_SCALES[Math.floor(next() * ODD_SCALES.length)] ?? 1);
    return {
      entry_id: `demo-${monday}-${count++}`,
      recipe_id: card.id,
      recipe_title: card.title,
      amount: { kind: "scale", factor },
    };
  };
  const days = Array.from({ length: 7 }, (_, day) => {
    if (order.length === 0 || free.has(day)) return [];
    return next() < 0.15 ? [entry(), entry()] : [entry()];
  });
  return { schema_version: 1, week_start: monday, version: 0, grocery_ticks: [], days };
}

// A write to a Demo, as the API would apply it: a placement goes at the end of its day as a new
// entry, titled from its card, and does nothing if the recipe isn't in the Collection.
export function applyDemoOperations(
  plan: WeekPlan,
  operations: WeekOperation[],
  cards: DemoCard[],
): WeekPlan {
  const version = plan.version + 1;
  let days = plan.days;
  operations.forEach((operation, n) => {
    if (operation.op === "place") {
      const card = cards.find((c) => c.id === operation.recipe_id);
      if (!card) return;
      const placed: WeekPlanEntry = {
        entry_id: `demo-${plan.week_start}-v${version}-${n}`,
        recipe_id: card.id,
        recipe_title: card.title,
        amount: operation.amount ?? { kind: "scale", factor: 1 },
      };
      days = days.map((entries, day) => (day === operation.day ? [...entries, placed] : entries));
    } else if (operation.op === "remove") {
      days = days.map((entries) => entries.filter((e) => e.entry_id !== operation.entry_id));
    } else {
      days = days.map((entries) =>
        entries.map((e) =>
          e.entry_id === operation.entry_id ? { ...e, amount: operation.amount } : e,
        ),
      );
    }
  });
  return { ...plan, version, days };
}
