import type { Card } from "./api/client";
import { byTitle } from "./titleSearch";

type Counts = Card["needs_review"];

// Whether a card still has unchecked items: an open Enrichment Issue or an unconfirmed Review Item.
export const needsReview = ({ needs_review }: Card) =>
  needs_review.open_issues + needs_review.unconfirmed > 0;

// The cards that need review, Awaiting Review first, then those with the most open Enrichment
// Issues, then by title.
export function reviewQueue<C extends Card>(cards: readonly C[]): C[] {
  const awaiting = (card: Card) => Number(card.status !== "awaiting_review");
  return cards
    .filter(needsReview)
    .sort(
      (a, b) =>
        awaiting(a) - awaiting(b) ||
        b.needs_review.open_issues - a.needs_review.open_issues ||
        byTitle(a, b),
    );
}

// "5 to check, incl. 2 flagged", leaving out a part that is zero: the items with an unconfirmed
// fact, and the open Enrichment Issues.
export function reviewCounts({ open_issues, unconfirmed }: Counts): string {
  const flagged = open_issues ? `${open_issues} flagged` : "";
  if (!unconfirmed) return flagged;
  return flagged ? `${unconfirmed} to check, incl. ${flagged}` : `${unconfirmed} to check`;
}
