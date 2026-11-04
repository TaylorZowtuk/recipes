import { describe, expect, it } from "vitest";
import type { Card } from "./api/client";
import { needsReview, reviewCounts, reviewQueue } from "./needsReview";

const card = (title: string, fields: Partial<Card> = {}): Card => ({
  id: `01K7TEST-${title}`,
  title,
  site_name: null,
  stated_seconds: null,
  status: "ready",
  preview: null,
  difficulty: null,
  difficulty_suggested: false,
  tags: [],
  needs_review: { open_issues: 0, unconfirmed: 0, flagged: 0 },
  recipe_version: 1,
  schema_version: 1,
  ...fields,
});

describe("needsReview", () => {
  it("holds a card with a Review Item left to check", () => {
    const left = (unconfirmed: number, flagged: number) =>
      card("A", { needs_review: { open_issues: flagged, unconfirmed, flagged } });
    expect(needsReview(card("A"))).toBe(false);
    expect(needsReview(left(1, 1))).toBe(true);
    expect(needsReview(left(2, 0))).toBe(true);
  });
});

describe("reviewQueue", () => {
  it("keeps the cards with unchecked items, Awaiting Review first, then most open Issues", () => {
    const cards = [
      card("Synthetic Apple Bake", {
        needs_review: { open_issues: 0, unconfirmed: 4, flagged: 0 },
      }),
      card("Synthetic Beans", {
        status: "awaiting_review",
        needs_review: { open_issues: 0, unconfirmed: 1, flagged: 0 },
      }),
      card("Synthetic Checked Soup"),
      card("Synthetic Dal", { needs_review: { open_issues: 3, unconfirmed: 1, flagged: 1 } }),
      card("Synthetic Eggs", {
        status: "awaiting_review",
        needs_review: { open_issues: 2, unconfirmed: 5, flagged: 2 },
      }),
      card("Synthetic Aioli", { needs_review: { open_issues: 0, unconfirmed: 1, flagged: 0 } }),
      card("Synthetic Pending Pie", { status: "pending" }),
    ];
    expect(reviewQueue(cards).map((c) => c.title)).toEqual([
      "Synthetic Eggs",
      "Synthetic Beans",
      "Synthetic Dal",
      "Synthetic Aioli",
      "Synthetic Apple Bake",
    ]);
  });
});

describe("reviewCounts", () => {
  it("says how many items are to check, and how many of those are flagged", () => {
    expect(reviewCounts({ unconfirmed: 5, flagged: 2 })).toBe("5 to check, incl. 2 flagged");
    expect(reviewCounts({ unconfirmed: 5, flagged: 0 })).toBe("5 to check");
    expect(reviewCounts({ unconfirmed: 0, flagged: 0 })).toBe("");
  });
});
