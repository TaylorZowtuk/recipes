import { fold } from "./fold";

// The cosmetic part of a recipe's URL: its title, lower-cased and without accents, with every run
// of other characters turned into one hyphen. The id alone finds the recipe.
export function slug(title: string): string {
  return (
    fold(title)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "recipe"
  );
}

// A recipe's path, asking it to open at `scale` when that isn't 1.
export function recipePath({ id, title }: { id: string; title: string }, scale = 1): string {
  return `/recipes/${id}/${slug(title)}${scale === 1 ? "" : `?scale=${scale}`}`;
}
