# Fridge matching runs on the phone over an index on each card, matching exact Canonical Ingredients and Confirmed substitutions, with no LLM

The Fridge tab ranks recipes by what someone has on hand. The frontend computes the ranking with one pure TypeScript function over the card items it already loads for the Recipes grid, the Canonical Ingredients and the device's **Fridge**. It works offline and while the kill switch has made the API read-only. We rejected matching in the API, because it wouldn't work offline and every search would query every card. We rejected matching over full recipe items, because the phone would have to download all of them first.

## The fridge index on each card

The API writes a `fridge` index onto each card, computed from the recipe's **effective lines** (the Original with Our Version applied), across all Components:

```json
"fridge": {
  "needs":    [{"c": "<canonical_id>", "subs": ["<canonical_id>", …]}, …],
  "optional": ["<canonical_id>", …],
  "unresolved": ["1 bunch something odd", …]
}
```

- **`needs`:** each Canonical Ingredient a line requires, with the substitutes of its **Confirmed** substitutions only. Unconfirmed substitutions are hidden, as the [enrichment ADR](2026-09-26-enrichment-pipeline.md) says.
- **`optional`:** lines whose quantity is "to taste" (`null`) or whose `parse.optional` is true ("optional", "for garnish", "to serve"). `optional` is set deterministically from the parser's comment field, and editors can confirm it like any other fact.
- **`unresolved`:** lines that are pending or have no Canonical Ingredient, as written.

The API recomputes the index whenever it writes the recipe, which is already in the same transaction as the card. **Pantry Staple** flags are *not* baked in: they're applied when matching, so marking a staple takes effect at once without rewriting any card.

## Input

A typeahead picker over the Canonical Ingredients, which also searches the wording cache ("boneless thighs" suggests *chicken thigh*). A tap adds a chip. Families aren't offered.

We rejected free text and the enum-constrained Groq/Gemini call that the [free-LLM research](https://github.com/TaylorZowtuk/recipes/issues/5) allowed for. Visitors can use the Fridge tab, so the endpoint would be public and could spend the free quota. It also couldn't work offline or while the API is read-only, and the typeahead covers most of what it would add. Nothing the Fridge does writes to the wording cache. A pasted-list input resolved deterministically can be added later without changing anything here.

## What counts as having an ingredient

A need is **had** when the Fridge holds:

1. its exact Canonical Ingredient, or
2. one of its Confirmed substitutes. This is shown as a **swap** ("have Greek yogurt for sour cream").

Family matches don't count: *chicken breast* does not cover *chicken thigh*. Families are enrichment's grouping and are too broad to treat as interchangeable (feta and parmesan are both *cheese*). A Confirmed substitution is the household saying that particular swap works.

## Counting

- **Pantry Staples** are ignored: never missing and never counted as matches.
- **Optional** lines are never missing. They count as matches only when they're in the Fridge.
- **Unresolved** lines always count as missing, shown as written, because nothing shows they're on hand.
- Ratio Recipes are matched on their parts like any other recipe.
- Only *Ready* recipes are matched.

## Ranking

- Only recipes that use at least one Fridge ingredient are listed, so a spice blend made entirely of staples doesn't flood the list.
- Sorted by **missing** ascending, then **matches** descending, then fewer **swaps**, then title.
- Grouped under "Nothing missing", "Missing 1", "Missing 2" and "Missing 3+" (collapsed). Each card lists what's missing and any swaps.
- The Fridge tab has no filters. Tags and Difficulty filters stay on the Recipes tab.

## The Fridge is kept on the device

The Fridge persists on the device until it's cleared with "Clear", like cooking progress. Each phone and each visitor has their own. It never reaches the server and isn't synced. We rejected a shared household Fridge because it would add another item to sync for little gain, and visitors couldn't use it.
