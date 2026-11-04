import type { Card } from "./api/client";
import { byTitle } from "./titleSearch";

type Counts = Card["needs_review"];

// Whether a card still has a Review Item left to check, flagged or not.
export const needsReview = ({ needs_review }: Card) => needs_review.unconfirmed > 0;

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

// "5 to check, incl. 2 flagged": the Review Items left to check, and those of them carrying an
// open Enrichment Issue, left out when none do. Nothing when no item is left.
export function reviewCounts({ unconfirmed, flagged }: Pick<Counts, "unconfirmed" | "flagged">) {
  if (!unconfirmed) return "";
  return flagged ? `${unconfirmed} to check, incl. ${flagged} flagged` : `${unconfirmed} to check`;
}
