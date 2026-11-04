# An editor confirms a Review Item, not a fact, and a confirm names no one

The [recipe data model ADR](2026-09-29-recipe-data-model.md) says a fact is the unit an editor confirms in one tap, and leaves `confirmed_by` to name who confirmed it. This supersedes those two points. It also records what a Confirm Batch stamps, so undo can reverse it. Everything else in the recipe data model ADR stands.

We chose this because confirming a line's parse, match and conversion one by one is three taps for what an editor checks at a glance, and a count of facts overstates what is left to review. And recipes are public: the API serves each version from `/api/v/recipes/…` to anyone, cached at CloudFront for good, so whatever a confirm writes into a recipe is published with it.

## Review Items

A **Review Item** is what an editor checks and confirms in one tap, and what Needs Review counts. Its id is the id of the line or step it belongs to, and its facts are found by path:

- **An ingredient line** (`i3`): its `i3.parse`, `i3.match` and `i3.conversion`, whichever it has.
- **A line's substitutions** (`i3.substitutions`): an item of their own, because they're hidden until confirmed and checked apart from the line.
- **A step** (`s2`): its `s2.segments` and `s2.uses`, whichever it has.
- **The Suggested Difficulty** (`difficulty`), unless the editor set the recipe's own Difficulty, which always wins over the suggestion. Confirming it then would change nothing, so it isn't asked for.
- **An open Enrichment Issue** joins the item its fact belongs to (`i3.match` to `i3`, `difficulty` to `difficulty`), and makes that item when the recipe lacks its facts, such as an issue on `i5.match` for a line with no facts. Otherwise the editor would have nothing to accept the correction from, while the issue kept the recipe from *Ready*.

An item is unconfirmed while any fact it has is, and flagged while it carries an open Enrichment Issue; it is left to check while either holds. A card's `needs_review` holds `unconfirmed`, the number of Review Items left to check, `flagged`, how many of those are flagged, and `open_issues`, the number of open Enrichment Issues, which the Needs Review sort uses. The card and each tab's review bar read "M to check, incl. N flagged" from `unconfirmed` and `flagged`, so N is never above M, and a tab's badge is its M. A recipe *Awaiting Review* becomes *Ready* once `unconfirmed` is 0, which also means no open issue is left.

The API's `review_items` and the PWA's `reviewItems` both apply this rule. One shared synthetic fixture, `backend/tests/fixtures/review_items.json`, holds the expected items and count for each case, and pytest and Vitest both check against it.

## Confirm Batches

- Confirming stamps every fact it confirms, every open Enrichment Issue it resolves and every Canonical Ingredient it confirms (`CanonicalIngredient.confirm_batch`) with one new `confirm_batch` id. A fact already Confirmed keeps its own batch.
- `Recipe.ready_batch` records the batch that moved the recipe from *Awaiting Review* to *Ready*, so undoing that batch moves it back.
- Setting the recipe's own Difficulty can leave nothing to review, and the recipe is then *Ready* with no `ready_batch`, so undoing an earlier batch leaves it *Ready*.
- Undo reverses exactly one batch on the recipe as it is now: it unconfirms the batch's facts, reopens its issues, and unconfirms each Canonical Ingredient still stamped with it. One stamped with another batch, such as one first confirmed from another recipe, stays Confirmed. Learned wordings stay.

## `confirmed_by` names no one

A Confirmed fact's `confirmed_by` holds the fixed value `"editor"`, never the signed-in editor's email. The [editor sign-in ADR](2026-09-29-editor-sign-in.md) keeps the allowlisted emails in SSM because the repo is public, and a cached recipe version can't be taken back once served. Confirming needs an editor, but the API doesn't record which one.

## Consequences

- An editor confirms a whole line, step or suggestion in one tap, and "Confirm N on this tab" confirms every unchecked item on the tab at once.
- The household can't see which of them confirmed a fact. With one or two editors, that's no loss.
- The grouping is written twice, in Python and TypeScript, and the shared fixture is what keeps the two the same.

## Considered options

- **The API sends the items with the recipe:** one source of truth, but a field only in responses, on a cached, versioned read, and a larger change than the rule needs.
- **Store an opaque per-editor id in `confirmed_by`:** tells editors apart without an email, but nothing reads it, and it would still be published.
