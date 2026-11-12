# An editor's edit is Confirmed, not undoable, and fixes a wording for the whole Collection

The [Wording Cache ADR](2026-10-28-wording-cache-learns-unconfirmed.md) says the store refuses to overwrite a confirmed wording. This supersedes that point for editors: an editor who changes a line's Canonical Ingredient overwrites the wording, even a confirmed one. Enrichment still never replaces a confirmed wording. Everything else in that ADR, and in the [Review Items and Confirm Batches ADR](2026-11-03-review-items-and-confirm-batches.md), stands.

We chose this because confirming only says "this is right". When it's wrong, the editor needs to correct it from the same sheet, and a wrong mapping such as "cream" → *ice cream* should be fixed once, not in every recipe that says "cream".

## One edit at a time

`POST /api/recipes/{id}/edit` takes `{version, edit}`, where `edit` is one Review Item's change, by `kind`: a `line`, a `step`, a `substitution` or `remove_substitution`, or the `difficulty`. A stale `version` is a 409, and nothing is written, and so is an edit of a Pending recipe, which has no facts yet. An edit that would make the recipe too big to store is a 422.

- **Every fact the edit writes** is Confirmed with provenance `editor`, confidence 1, `confirmed_by` `"editor"` and **no Confirm Batch**, so no undo reverses it. An edit isn't a batch: the editor undoes it by editing again. The edited item's open Enrichment Issues are resolved, also in no batch, and a recipe Awaiting Review with nothing left to check is Ready, with no `ready_batch`.
- **A line**: the editor saves the whole line, so its parse is the editor's, and its match and conversion are Confirmed as they stand (each keeping any batch it was already confirmed in), as a Confirm would. A line whose wording changes needs a Canonical Ingredient choice (a 422 without one), since keeping the match would confirm the old Canonical Ingredient for the new wording. The unit's kind (mass, volume or count) stays as the parser read it while the unit is unchanged, and a changed unit's kind follows the units the parser reads, so the API needs no parser.
- **Keep or convert weight**: keeping the written unit sets the conversion's `refused` to "kept in the written unit by an editor" and keeps its FDC numbers, and the reason wins over a density wherever the PWA reads it. Converting clears the reason, and is refused when the FDC food gives no density or grams per count.
- **A step**: the editor sets each ingredient segment's Step Portion and each timer's range. The uses follow the segments, and a line's portions across the steps still add up to at most 1. A timer needn't match the step's text, unlike enrichment's, but no segment is added or removed.
- **A substitution**: the editor sets its ratio and note, or removes it. Removing the last leaves the line no substitutions.
- **The Difficulty**: the editor's values are both the Confirmed suggestion and the recipe's own Difficulty.

## A new Canonical Ingredient fixes the wording

The editor picks an existing Canonical Ingredient, Confirming it if it wasn't, or creates one, Confirmed, in one of the Kitchen settings' Store Categories. Then:

- **The FDC food comes from another line.** A conversion belongs to the FDC food and portion, not to the line, so the line copies the match's FDC food and the conversion of a line already matched to that Canonical Ingredient, a Confirmed one first, keeping the conversion's `estimated`. With no such line, or for a new one, the match has no FDC food (`fdc_id` is null) and the line has no conversion. No number is made up.
- **The wording is fixed.** The line's wording, after any change to its name, is Confirmed in the Wording Cache for that Canonical Ingredient, overwriting whatever was there.
- **Every recipe follows.** Every line in the Collection with that wording takes the same match and conversion, Confirmed by the editor, including lines already Confirmed, and their issues on the match and conversion are resolved. Only the edited recipe's version is checked against the request. Each other recipe is written on its own at its own version, read again and retried if it changed meanwhile, with its card, so one edit is never more than a transaction holds.

## Consequences

- A mapping an editor corrects is fixed once for the whole Collection, and enrichment offers only it from then on.
- The other recipes aren't written in the edited recipe's transaction. If the API stops partway, some keep the old match until an editor picks the Canonical Ingredient again; they never hold a half-written recipe.
- Once the edited recipe is saved, the edit succeeds. A recipe that kept changing through every retry is skipped and listed in the response's `not_updated`, and one the match would make too big to store in `too_big`, beside `also_updated`. The editor is told how many of each weren't updated.
- Picking the same Canonical Ingredient again retries them: the PWA always offers the line's current Canonical Ingredient beside Keep, and choosing it shares the line's match and conversion with every recipe with that wording again. A line saved with its Canonical Ingredient unchanged never reaches other recipes, so a line another recipe deliberately Confirmed as a different Canonical Ingredient is left as it is. A recipe in `too_big` stays too big on every retry, so the editor is told it can't be updated rather than to retry.
- A line an editor matched to a new Canonical Ingredient has no nutrition or weight until a later enrichment, or an editor, gives that Canonical Ingredient an FDC food.

## Considered options

- **Stamp an edit with a Confirm Batch, so undo reverses it:** rejected, because undoing a wording fixed across the Collection would mean reverting other recipes the editor never opened.
- **Write every recipe sharing the wording in one transaction:** rejected, because a common wording such as "salt" can be in more recipes than one transaction holds.
- **Ask the editor for the FDC food of a new Canonical Ingredient:** left for later; for now it has none rather than a guess.
