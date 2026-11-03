import { fold } from "./fold";

// Whether a title contains the query anywhere, ignoring case, accents and the spaces around the
// query. An empty query matches every title.
export function titleMatches(title: string, query: string): boolean {
  return fold(title).includes(fold(query.trim()));
}

// Orders strings alphabetically, ignoring case and accents: titles and Tags sort the same way.
export const alphabetical = new Intl.Collator("en", { sensitivity: "base" }).compare;

// Orders cards alphabetically by title.
export const byTitle = (a: { title: string }, b: { title: string }) =>
  alphabetical(a.title, b.title);
