# Editors pick FDC foods; the FDC Snapshot ships in the Lambda

This supersedes part of the [editing ADR](2026-11-11-editing-review-facts.md): a line an editor matches no longer copies the FDC food, portion and conversion of another line matched to the same Canonical Ingredient, and a match no longer goes without an FDC food (`fdc_id` is required again). Everything else in that ADR stands.

Until now the API couldn't look up an FDC food, because the Lambda zip left the FDC Snapshot out. So a line an editor matched to a new Canonical Ingredient had no FDC food, and so no weight or nutrition, and enrichment never filled them in because the match was Confirmed. A line matched to an existing Canonical Ingredient copied another line's portion, which may not fit its own unit: a clove's weight copied onto "1 tbsp garlic". And an editor couldn't change a line's FDC food at all.

## The FDC Snapshot and pint ship in the Lambda

- The FDC Snapshot moves from `backend/fdc/` into the package, at `backend/src/recipes/data/<release>.json.gz`, and `make lambda` puts it in the zip gzipped as committed, about 370 KB.
- The API loads it on first use, by the FDC search or a line edit that picks a food, and keeps it for the life of the Lambda; never at import, so a cold start that only reads is no slower. Loading it took about 155 ms and 68 MB of memory (x86, in the toolchain container), well inside the API's 512 MB.
- `pint` moves from the `enrich` dependency group to the main dependencies. Only the parser (`ingredient-parser-nlp`, which pulls in `nltk` and `numpy`) was the reason for the group, and the zip still leaves those out. One pint `UnitRegistry`, also built on first use and shared by every unit, takes about 415 ms and 13 MB.

## An editor picks the line's FDC food

- `GET /api/fdc/foods?q=…`, for editors only, searches the FDC Snapshot as the Work Packet's offers do. `q` is 2 to 60 characters, and the answer, `{foods, default_fdc_id}`, is at most 10 foods, each with its portions and what each portion converts by (`fdc.convert`'s density, or grams per count unit), sent `Cache-Control: no-store`.
- The picker starts from the line's current food and portion. After a Canonical Ingredient change to an existing one, it starts from the food of a line anywhere in the Collection already matched to it, a Confirmed one first, with no portion, since that line's portion may not fit this one's unit. The PWA holds only the recipe it shows, so the search finds that food: its first request, for the Canonical Ingredient's name, also sends `canonical`, and the answer names the food as `default_fdc_id` and lists it first. It sends `fdc_id`, the line's own food, too, so the picker can name that food when the search wouldn't find it. The picker sends `canonical` and `fdc_id` once, on its first search, since `canonical` reads the Collection's recipes; the searches after it, as the editor types or edits the unit, send only `q`, `unit` and `unit_kind`. A new Canonical Ingredient starts from a search for its name, with no food chosen.
- Every line edit carries the line's `fdc_id` and `portion_id`, which may be null. The food is required for a line that has or gets a Canonical Ingredient, and refused for a line with none: a line with no Canonical Ingredient has no match, and so no food, and the picker is hidden for it. Either is a 422 naming the line.
- **Every match has an FDC food.** When none really fits (za'atar), the editor picks the closest, as enrichment's model already must. A portion may be left unchosen. The picker says when the chosen portion is the wrong kind for the line's unit (a clove on "1 tbsp garlic"), so the line gets no weight, but doesn't stop the save. The API decides, so the rule has one copy: each search sends the line's `unit` as the form has it (empty for none), and the parser's `unit_kind` while the unit is as the parser read it, and each portion in the answer says whether it `fits`, by the same `fdc.fits` a spread pick uses (below), which lives in `fdc` next to `fdc.convert`. Editing the unit searches again, and until that answer arrives the picker says nothing.
- **The weight choice goes with the pick.** A line an editor kept in its written unit stays kept when they pick another food and portion, and the form offers converting to a weight only while the picked portion gives something to convert by.
- **One function makes the numbers.** `fdc.numbers(snapshot, fdc_id, portion_id)` turns the pick into the numbers stored in the `ConversionFact`, using `fdc.convert`. A food the Snapshot doesn't have, or a portion that isn't the food's, is a 422 naming the line, never a stored refusal. No portion stores the "no portion chosen" refusal. The later slices use the same function.

## A pick spreads by each line's written unit

A new food or portion fixes the wording as a new Canonical Ingredient does: the Wording Cache confirms it, and every line with the same wording, in every recipe, takes the match, Confirmed by the editor. A line saved with its Canonical Ingredient, food and portion all unchanged is Confirmed as it stands and reaches no other recipe.

Every such line takes the food, but a portion only where it fits the line's own written unit. The editor's own line keeps the portion they chose. Another line takes:

1. **the chosen portion**, if it is the same kind as the line's unit: any volume unit for a volume portion, since a density works for every volume, and the same count word, ignoring case, plurals and a written "(s)" or "(es)" ("clove(s)" counts in cloves), for a count. A line with no unit ("2 eggs") fits only a generic count (each, piece, unit, item) or a size (small, medium, large, extra large, jumbo).
2. **otherwise, the food's portion that fits**: for a volume line, its first portion that gives a density, and for a count line, its first portion counted in the line's unit word, or, for a line with no unit, its first in a generic count or a size.
3. **otherwise, no portion**: the "no portion chosen" conversion, and an open Enrichment Issue on the line's conversion asking an editor to pick a portion. It never silently stays in its written unit. The issue proposes no correction (it has no before or after), so its sheet offers no Accept correction: the editor settles it by editing the line and picking a portion. The API holds the rule: confirming the line's facts, even with another issue's correction, leaves the ask open, so the recipe stays flagged and isn't Ready until an edit settles it.

A mass line needs no portion, so it takes the chosen one as it is and never gets an issue. Nor can any portion give a line with no amount ("salt, to taste") a weight, so it too takes the chosen portion as it is and gets no issue.

Example: an editor picks *Garlic, raw*, "1 clove", on "4 cloves garlic". Another recipe's "1 tbsp garlic, minced" gets *Garlic, raw* with the food's first portion that gives a density, or an open Enrichment Issue if none does. It never gets the clove. A Ready recipe that gains an issue this way stays Ready.

## Releases

Each `ConversionFact` and substitution keeps the `release` its numbers came from. `Recipe.fdc_release` is the release enrichment used, so it is only approximate once an editor's pick can bring a newer release's numbers into one of the recipe's lines.

## Decided now for later slices

- **The enrichment request will send only `{fdc_id, portion_id}`**, and the API fills in the numbers with `fdc.numbers`, refusing a request made for another FDC Snapshot release than the one it holds. Today's request sends the numbers.
- **"Kept in the written unit by an editor" stays its own choice, apart from the portion.** Choosing no portion loses the density or gram weight, and so the line's weight and nutrition; keeping the written unit keeps them, and only shows the line as written.

## Consequences

- No line an editor matches is left without weight and nutrition for want of an FDC food; at worst it has an open Enrichment Issue asking for a portion.
- The zip is about 370 KB bigger, and the first request on a Lambda that searches or picks a food is slower by the load. Reads never pay it.
- Numbers are still copied into facts: the [recipe data model ADR](2026-09-29-recipe-data-model.md) rejected looking them up on read, and that stands.

## Considered options

- **Keep copying another line's portion and conversion:** rejected, because a portion belongs to a unit, so a copied one can give "1 tbsp garlic" a clove's weight.
- **Leave a line with no FDC food when nothing fits:** rejected, because it has no weight or nutrition, and enrichment never revisits a Confirmed match. The closest food is better than none.
- **Give every line the chosen portion:** rejected for the same reason as copying. Leaving a line no portion fits in its written unit was rejected too, since it would look settled while having no weight.
- **Look FDC foods up in a service, not the zip:** rejected; the Snapshot is small enough to bundle, and the API stays on Always Free with nothing new to run.
