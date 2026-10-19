import { fold } from "./fold";

// Whether a title contains the query anywhere, ignoring case, accents and the spaces around the
// query. An empty query matches every title.
export function titleMatches(title: string, query: string): boolean {
  return fold(title).includes(fold(query.trim()));
}

const collator = new Intl.Collator("en", { sensitivity: "base" });

// Orders cards alphabetically by title, ignoring case and accents.
export const byTitle = (a: { title: string }, b: { title: string }) =>
  collator.compare(a.title, b.title);
