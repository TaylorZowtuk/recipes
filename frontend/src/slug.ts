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

export function recipePath({ id, title }: { id: string; title: string }): string {
  return `/recipes/${id}/${slug(title)}`;
}
