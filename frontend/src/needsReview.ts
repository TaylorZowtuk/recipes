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

// "2 flagged · 5 to check", leaving out a part that is zero.
export const reviewCounts = ({ open_issues, unconfirmed }: Counts) =>
  [open_issues && `${open_issues} flagged`, unconfirmed && `${unconfirmed} to check`]
    .filter(Boolean)
    .join(" · ");
