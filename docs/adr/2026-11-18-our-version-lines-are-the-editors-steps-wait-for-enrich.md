# Our Version's lines are the editor's, and its steps wait for enrich under an Our Version Status

Superseded in part by [Our Version's facts are one map](2026-11-21-our-version-facts-are-one-map.md): a wording fixed elsewhere reaches Our Version lines, so a line prepared another way takes the Canonical Ingredient with its food unconfirmed, not every fact Confirmed with provenance `editor`, and that line's Enrichment Issue makes Our Version `awaiting_review` before it is enriched. Everything else here stands.

Superseded in part by [A change to the Original flags Our Version's steps, and each issue says whether a confirm settles it](2026-11-23-original-changes-flag-our-version-steps.md): a Review step edit or a re-enrichment that takes a line past 1 across the effective steps isn't refused but flags each Our Version step that uses it, so the total may sit past 1 while flagged. That over-use issue settles only by an edit, while the affected-step and cap issues also settle by confirming the step as it is. Everything else here stands.

Supersedes in part the [recipe data model ADR](2026-09-29-recipe-data-model.md), where an Our Version edit "gets its own facts, re-parsed on save", and the [enrichment pipeline ADR](2026-09-26-enrichment-pipeline.md), where saving Our Version "runs the deterministic path on new or changed lines at once" and leaves the lines it can't resolve pending. Nothing is parsed on save, and no Our Version line is pending.

The parser isn't in the Lambda. `ingredient-parser-nlp`, nltk and numpy are in the `enrich` group, and the Lambda zip is built without it. Step Segments come from a model's answer to a Work Packet, which the API never asks for. So the API has nothing to parse an Our Version line or segment an Our Version step with when it's saved (TaylorZowtuk/recipes#116).

## Decision

### An edited or added ingredient line's facts are the editor's

- The editor saves the line through the same structured form as a Review line edit (`EditLine`): quantity, unit, name, preparation, FDC food and FDC portion, keep or convert weight, and a Canonical Ingredient when the wording is new or changed. The rules of the [editing review facts ADR](2026-11-11-editing-review-facts.md) and the ADRs that supersede parts of it apply as they stand. In particular, the unit's kind comes from the units the parser reads, with no parser.
- Every fact on the line is Confirmed, with provenance `editor`. No Our Version line is pending.
- **Its text is built from its fields**, as the recipe view shows a parsed line: "2 can diced tomatoes, drained". The view shows a line's parse, not its text, whenever it has one, so free text would only be shown in a few places, could disagree with the parse, and wouldn't change what the household sees. The text is still stored, so everything that falls back to `text` works unchanged.
- **A Canonical Ingredient chosen in Our Version fixes the wording for the whole Collection**, as a Review edit does. A wording's Canonical Ingredient is a fact about language, not about one recipe. A household that means "garlic paste" in one recipe writes "garlic paste".
- "Was ¾ cup" compares the parse with the replaced line's parse.

### An edited or added step waits for enrich

- It has no Segments or uses until `enrich` gives it some, and shows its raw text, as the data model ADR allows.
- A recipe with Our Version has an **Our Version Status**, `our_version_status` on the recipe and its card: `pending`, `awaiting_review` or `ready`. A recipe without Our Version has none. It is separate from the Enrichment Status (`status`), which stays Ready through all of it, so the recipe never leaves the Grocery List or fridge matching.
- Saving Our Version with an edited or added step makes it `pending`. A save that changes only ingredient lines leaves it as it was, or makes it `ready` when Our Version is new.
- `enrich` picks up every card whose `status` or `our_version_status` is `pending`. What Our Version needs from enrichment is `enrich`'s business, and isn't in the card or the API's shape. Today it is segmenting the Our Version steps without Segments, with the effective lines they can use.
- Once enriched, Our Version is `awaiting_review`. The steps are Review Items, counted in Needs Review, and confirming the last one left to check makes it `ready`, as it does for a recipe Awaiting Review.
- Editing a step again while it's `awaiting_review` makes Our Version `pending` and resolves that step's open Enrichment Issues. Deleting Our Version removes its Our Version Status and resolves its open issues.

### Steps an Our Version edit affects

- An unchanged step is affected when one of its Segments or uses is for a line that Our Version removed, or for an edited line whose name or Canonical Ingredient changed. A change of amount, unit or preparation alone doesn't affect it: "half the garlic" still reads right with 4 cloves instead of 3.
- In the effective recipe, a Segment for a removed line shows as its text, with no amount, and the step's uses drop the line.
- The step gets an Enrichment Issue that proposes no correction ("mentions parsley, which Our Version removed"), so it's a flagged Review Item and Our Version is `awaiting_review`. The editor settles it by editing the step in Our Version or by confirming it as it is.

### Step Portions still add up to at most 1

The rule holds across the effective steps. If an `enrich` answer would take a line past 1, as "all the garlic" in an edited step would when an unchanged step uses half, the Segment is stored at what's left and the step gets an Enrichment Issue naming the other steps. The editor fixes it by editing either step.

## Why

- **The parser in the Lambda** would roughly double the API's code (a 109 MB unpacked zip gains about 80 MB: numpy 57 MB, nltk and its data 14 MB, the parser 4.5 MB), slow a cold save (1.6 s to import and parse one line on a dev machine), and still couldn't segment steps. The Review line edit already shows the API needs no parser when the editor gives the parse.
- **Leaving lines pending for `enrich`** would leave a household's edit unscaled and under "Other" on the Grocery List until someone ran `enrich` by hand.
- **A status of its own**, rather than a list of steps to enrich, keeps the card and the API general: what `enrich` does for Our Version can grow without a new flag. Reusing the Enrichment Status would take the recipe off the Grocery List.

## Consequences

- Editing Our Version needs no new runtime dependency, and the Lambda zip keeps the parser out.
- An Our Version step edit shows as plain text, with no timers or scaled amounts, until `enrich` runs and an editor confirms it.
- A Ready recipe can now have Review Items left to check, from Our Version.
- An editor adding a line picks its Canonical Ingredient and FDC food at once, where an Original line has enrichment suggest them.

## Considered options

- **The parser in the Lambda, with matching from the Wording Cache:** rejected for the size, the cold start and the steps it still couldn't segment.
- **Parsed by the next `enrich` run:** rejected, because `enrich` runs by hand and the lines would be unusable until then.
- **The deterministic parse on save, with matching and Segments left for `enrich`:** rejected, as it needs the parser in the Lambda too.
- **The editor types free text and the fields separately:** rejected, because the two could disagree and the text is rarely shown.
- **The editor marks an edited step's Segments by hand:** rejected as a large new UI for an occasional edit.
- **A list of Steps to Enrich on the card:** rejected, because it ties the card and the API to what `enrich` does today.
- **A badge on affected steps, worked out on read:** rejected, because it couldn't be dismissed for a step the editor decided is fine.
- **Letting Our Version's Step Portions add up to more than 1:** rejected, because a step could then show more of a line than the line has.
