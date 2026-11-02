import { describe, expect, it } from "vitest";
import type { Card } from "./api/client";
import {
  activeFilterCount,
  type CardFilters,
  collectionTags,
  filterCards,
  noFilters,
  toggleTag,
} from "./cardFilters";

const card = (title: string, fields: Partial<Card> = {}): Card => ({
  id: `01K7TEST-${title}`,
  title,
  site_name: null,
  stated_seconds: null,
  status: "ready",
  preview: null,
  difficulty: null,
  tags: [],
  needs_review: { open_issues: 0, unconfirmed: 0 },
  recipe_version: 1,
  schema_version: 1,
  ...fields,
});

const cards = [
  card("Synthetic Noodles", {
    tags: ["weeknight", "vegetarian"],
    difficulty: { prep: 2, cook: 2, cleanup: 2 },
    stated_seconds: 1800,
  }),
  card("Synthetic Soup", {
    tags: ["Weeknight", "soup"],
    difficulty: { prep: 1, cook: 2, cleanup: 1 },
    stated_seconds: 2400,
  }),
  card("Synthetic Oats", { tags: ["breakfast"], difficulty: { prep: 1, cook: 1, cleanup: 1 } }),
  card("Synthetic Blend", { tags: ["spice blend"], stated_seconds: 300 }),
];

const titles = (filters: Partial<CardFilters>) =>
  filterCards(cards, { ...noFilters, ...filters }).map((c) => c.title);

describe("filterCards", () => {
  it("keeps every card with no filters", () => {
    expect(titles({})).toHaveLength(4);
  });

  it("keeps cards with a chosen Tag, ignoring case", () => {
    expect(titles({ tags: ["WEEKNIGHT"] })).toEqual(["Synthetic Noodles", "Synthetic Soup"]);
  });

  it("keeps only cards with every chosen Tag", () => {
    expect(titles({ tags: ["weeknight", "Vegetarian"] })).toEqual(["Synthetic Noodles"]);
    expect(titles({ tags: ["vegetarian", "soup"] })).toEqual([]);
  });

  it("keeps cards at or under a maximum Total Difficulty, dropping those without one", () => {
    expect(titles({ maxTotalDifficulty: 4 })).toEqual(["Synthetic Soup", "Synthetic Oats"]);
    expect(titles({ maxTotalDifficulty: 3 })).toEqual(["Synthetic Oats"]);
  });

  it("keeps cards with easy cleanup (Cleanup 1), dropping those without a Difficulty", () => {
    expect(titles({ easyCleanup: true })).toEqual(["Synthetic Soup", "Synthetic Oats"]);
  });

  it("keeps cards at or under a maximum Stated Time, dropping those without one", () => {
    expect(titles({ maxStatedSeconds: 1800 })).toEqual(["Synthetic Noodles", "Synthetic Blend"]);
    expect(titles({ maxStatedSeconds: 900 })).toEqual(["Synthetic Blend"]);
  });

  it("combines every filter", () => {
    expect(titles({ tags: ["weeknight"], easyCleanup: true, maxStatedSeconds: 3600 })).toEqual([
      "Synthetic Soup",
    ]);
    expect(titles({ tags: ["weeknight"], maxTotalDifficulty: 4, maxStatedSeconds: 1800 })).toEqual(
      [],
    );
  });
});

describe("toggleTag", () => {
  it("chooses a Tag, then takes it away again whatever its case", () => {
    const chosen = toggleTag(noFilters, "weeknight");
    expect(chosen.tags).toEqual(["weeknight"]);
    expect(toggleTag(chosen, "Weeknight").tags).toEqual([]);
  });
});

describe("activeFilterCount", () => {
  it("counts each chosen Tag and each other filter that is set", () => {
    expect(activeFilterCount(noFilters)).toBe(0);
    expect(
      activeFilterCount({
        tags: ["weeknight", "soup"],
        maxTotalDifficulty: 5,
        easyCleanup: true,
        maxStatedSeconds: 900,
      }),
    ).toBe(5);
  });
});

describe("collectionTags", () => {
  it("lists each Tag once, ignoring case, alphabetically", () => {
    expect(collectionTags(cards)).toEqual([
      "breakfast",
      "soup",
      "spice blend",
      "vegetarian",
      "weeknight",
    ]);
  });

  it("is empty for a Collection without Tags", () => {
    expect(collectionTags([card("Synthetic Plain")])).toEqual([]);
  });
});
