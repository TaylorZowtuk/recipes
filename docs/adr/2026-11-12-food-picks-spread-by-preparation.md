# A food pick reaches only lines prepared the same way

This supersedes part of the [editors pick FDC foods ADR](2026-11-11-editors-pick-fdc-foods.md): there, every line in the Collection with the wording an editor fixed takes the food they picked. Now the Canonical Ingredient still goes to every line with the wording, but the FDC food goes only to lines with exactly the same preparation. Everything else in that ADR stands, including how a line that takes the food takes the portion that fits its own written unit.

A wording is the line's parsed name, and the parser puts a cooking state or a part of the food in the preparation, not the name. So lines that need different FDC foods share a wording. In the household's recipes this is common; these lines, written for this ADR, parse the same way:

- "1 lemon, juiced", "juice of 1 lemon" and "1 lemon, cut in wedges" are all *lemon*: two are juice, one is the fruit.
- "3 cups cooked rice" and "1 cup rice" are both *rice*, cooked and dry.
- "2 cups chickpeas, cooked" and "1 can chickpeas, drained" are both *chickpeas*, home-cooked and canned.

Until now, an editor who picked "Rice, white, cooked" for one cooked-rice line gave it, Confirmed, to every dry-rice line with the wording, which then showed about a third of the calories it should. The Canonical Ingredient is right for all of them: cooked rice and dry rice are bought as one Grocery Item, and lemon juice is bought as lemons.

## The rule

- **The Canonical Ingredient goes to every line with the wording,** as before: the Wording Cache maps a wording to one Canonical Ingredient.
- **The food goes to a line with exactly the same preparation:** compared as a wording is (lowercase, spacing collapsed, surrounding punctuation stripped), and a line with no preparation matches only another with none. That line takes the food and the portion that fits it, as the earlier ADR says.
- **A line prepared another way keeps its own food,** and is left as it is when its Canonical Ingredient doesn't change, so a food pick that keeps the Canonical Ingredient reaches, of the lines with a match, only those prepared the same way. It still reaches a line prepared another way that has no match yet, or that is matched to another Canonical Ingredient.
- **When its Canonical Ingredient changes,** such a line takes the new Canonical Ingredient, keeps its food, portion and conversion, and gets an open Enrichment Issue on its match asking an editor to pick its food, since a food picked for the old Canonical Ingredient may be wrong ("cream" moved from *ice cream* to *cream* leaves "2 tbsp cream, whipped" with an ice cream until someone picks). A line with no match yet takes the picked food, with the same ask. Like the ask for a portion, the issue proposes no correction, so only an edit of the line settles it, and the recipe stays flagged until then.
- **The match it keeps is unconfirmed,** with its old provenance and confidence, not Confirmed by an editor: nobody confirmed that food for the new Canonical Ingredient, and an editor's confirmation is in no Confirm Batch, so no undo would ever take back one nobody gave. Unconfirmed, it doesn't outrank a Confirmed line's food when the picker offers a default food for the Canonical Ingredient, and the line counts as still to check. For the same reason, the food a line prepared another way with no match yet takes is stored unconfirmed too, its conversion with it.

## Consequences

- A pick reaches fewer lines. Handling words count as a different preparation too: "kosher salt" doesn't reach "kosher salt, divided", nor "butter" reach "butter, softened", so an editor picks the same food more often. We accept that over telling food-changing words from handling words, which would need a word list to keep up.
- A preparation the text doesn't give still shares a food: "3 sprigs thyme" (fresh) and "1/2 tsp thyme" (dried) have none, so a pick on one reaches the other.
- A Canonical Ingredient change can leave Enrichment Issues in other recipes, which an editor settles by picking each line's food.

## Considered options

- **Spread the food only to lines with the same food-changing words** (cooked, juiced, canned…), ignoring handling words (divided, minced, softened): rejected for now, because the list would need keeping up and a missing word gives a wrong food silently.
- **The editor ticks which other lines take the food:** catches the thyme case, but adds a step to every food pick.
- **Don't spread the food at all:** never wrong, but every recipe's line needs its own pick.
- **Make the preparation part of the wording:** rejected, because the wording also chooses the Canonical Ingredient, and cooked and dry rice are one Grocery Item.
- **On a Canonical Ingredient change, give every line the food as before:** wrong for lemon, where "1 lemon, quartered" would take the juice.
- **Leave a line prepared another way with its old food and no issue:** rejected, because an ice cream's numbers could sit under a cream line unnoticed.
