# An editor picks a substitute's FDC food and FDC portion

This supersedes part of the [editing review facts ADR](2026-11-11-editing-review-facts.md): there, an editor sets a substitution's ratio and note, or removes it. Now the editor also sets each substitute's FDC food and FDC portion. Everything else about a substitution edit stands: it is one substitute at a time, by its index, Confirmed by the editor in no Confirm Batch, and removing the last leaves the line no substitutions.

Enrichment picks a substitute's FDC food and FDC portion as it does a line's, and can pick wrong: "unsalted butter" given salted butter, or a cup of quinoa given the dry grain where the recipe means cooked. Until now an editor could see that on the review sheet but not fix it there.

## The rule

- **The numbers come from the FDC Snapshot.** `POST /api/recipes/{id}/edit` with a `substitution` edit takes the substitute's `fdc_id` and `portion_id` (which may be null, for no FDC portion), and the API computes its FDC numbers with `fdc.numbers`, never taking them from the request. An unknown food, or an FDC portion that isn't the food's, is a 422 naming the substitute by its wording, and nothing is written.
- **An unchanged food and FDC portion keep the stored numbers.** The API loads the FDC Snapshot only when either changes, so editing just the ratio or note never rewrites the numbers enrichment stored.
- **The pick reaches no other line or recipe.** A line's food pick spreads by its wording through the Wording Cache ([food picks spread by preparation ADR](2026-11-12-food-picks-spread-by-preparation.md)). A substitute has no Wording Cache entry, since enrichment learns only a line's wording, so there is nothing to spread by: the edit changes only that substitute, and other substitutes of the line keep theirs.
- **The PWA's search starts from the substitute's wording**, with its current food named first and its current FDC portion chosen. It offers no Canonical Ingredient's default food, since that belongs to the line's match.
- **Fit is judged by the line's written unit.** The substitute takes the line's amount in its unit, scaled by its ratio, so the PWA says when the chosen FDC portion doesn't fit that unit, without stopping the save. The substitute has no Weight choice: keeping the written unit or converting is the line's.

## Consequences

- A wrong substitute food is fixed on the review sheet, like a line's, without re-running enrichment.
- An editor who corrects "unsalted butter" in one recipe corrects it there only. The same substitute in another recipe keeps enrichment's food until an editor picks it there too.

## Considered options

- **Spread a substitute's pick to every substitute with the same wording:** rejected for now. It would need a Wording Cache for substitutes, and substitutes are few enough that picking each is cheap.
- **Take the numbers from the PWA, which already has the food from the search:** rejected: the API would then store whatever a client sends as FDC numbers.
