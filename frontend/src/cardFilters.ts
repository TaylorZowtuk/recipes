import type { Card } from "./api/client";
import { totalDifficulty } from "./DifficultyMeters";
import { alphabetical } from "./titleSearch";

// What the Recipes tab narrows the Collection by. Each chosen Tag must match; null means "Any".
export type CardFilters = {
  tags: readonly string[];
  maxTotalDifficulty: number | null;
  easyCleanup: boolean;
  maxStatedSeconds: number | null;
};

export const noFilters: CardFilters = {
  tags: [],
  maxTotalDifficulty: null,
  easyCleanup: false,
  maxStatedSeconds: null,
};

const tagKey = (tag: string) => tag.toLowerCase();

// The cards that pass every filter, in their order. Tags match case-insensitively. A card without a
// Difficulty drops out under a Difficulty filter, and one without a Stated Time under a time one.
export function filterCards<C extends Card>(cards: readonly C[], filters: CardFilters): C[] {
  const chosen = filters.tags.map(tagKey);
  return cards.filter(({ tags, difficulty, stated_seconds }) => {
    const keys = new Set(tags.map(tagKey));
    if (!chosen.every((tag) => keys.has(tag))) return false;
    if (filters.maxTotalDifficulty !== null || filters.easyCleanup) {
      if (!difficulty) return false;
      if (
        filters.maxTotalDifficulty !== null &&
        totalDifficulty(difficulty) > filters.maxTotalDifficulty
      )
        return false;
      if (filters.easyCleanup && difficulty.cleanup !== 1) return false;
    }
    if (filters.maxStatedSeconds !== null) {
      if (stated_seconds === null || stated_seconds > filters.maxStatedSeconds) return false;
    }
    return true;
  });
}

export const isChosen = (filters: CardFilters, tag: string) =>
  filters.tags.some((chosen) => tagKey(chosen) === tagKey(tag));

// Adds a Tag to the chosen ones, or takes it away if it's already chosen, ignoring case.
export function toggleTag(filters: CardFilters, tag: string): CardFilters {
  const tags = isChosen(filters, tag)
    ? filters.tags.filter((chosen) => tagKey(chosen) !== tagKey(tag))
    : [...filters.tags, tag];
  return { ...filters, tags };
}

// How many filters are set: one for each chosen Tag and one for each other control.
export function activeFilterCount(filters: CardFilters): number {
  return (
    filters.tags.length +
    Number(filters.maxTotalDifficulty !== null) +
    Number(filters.easyCleanup) +
    Number(filters.maxStatedSeconds !== null)
  );
}

// The Collection's Tags, each once whatever its case (the first spelling seen), alphabetically.
export function collectionTags(cards: readonly Card[]): string[] {
  const tags = new Map<string, string>();
  for (const card of cards)
    for (const tag of card.tags) if (!tags.has(tagKey(tag))) tags.set(tagKey(tag), tag);
  return [...tags.values()].sort(alphabetical);
}
