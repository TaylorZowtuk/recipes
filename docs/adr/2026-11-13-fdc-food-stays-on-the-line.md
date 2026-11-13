# A line's FDC food belongs to the line, not to its Canonical Ingredient

Each ingredient line's match holds its own FDC food and FDC portion (`MatchFact.fdc_id` and `portion_id`), and a `CanonicalIngredient` holds neither. This records that this is deliberate: **the Canonical Ingredient owns no FDC food and no default FDC food.** Lines matched to the same Canonical Ingredient may have different FDC foods, in one recipe or in different ones.

## Why

The Canonical Ingredient and the FDC food answer different questions:

- **The Canonical Ingredient is what you buy.** The Grocery List merges into one Grocery Item per Canonical Ingredient ([grocery list aggregation ADR](2026-09-29-grocery-list-aggregation.md)), and fridge matching needs a line's exact Canonical Ingredient ([fridge matching ADR](2026-10-01-fridge-matching.md)).
- **The FDC food is what's in the bowl.** It gives the line's weight and nutrition.

Many lines are bought as one thing but need different FDC foods. These lines are written for this ADR, and the app's parser reads each as shown (name, then preparation):

| Bought as | Lines | Parsed | FDC foods they need |
| --- | --- | --- | --- |
| *lemon* | "1 lemon, juiced", "juice of 1 lemon", "1 lemon, cut in wedges" | *lemon*, "juiced"; *lemon*, "juice of"; *lemon*, "cut in wedges" | juice for the first two, the fruit for the third |
| *rice* | "3 cups cooked rice", "1 cup rice" | *rice*, "cooked"; *rice*, none | cooked rice and dry rice |
| *chickpeas* | "2 cups chickpeas, cooked", "1 can chickpeas, drained" | *chickpeas*, "cooked"; *chickpeas*, "drained" | home-cooked and canned |
| *thyme* | "3 sprigs thyme", "1/2 tsp thyme" | *thyme*, none; *thyme*, none | fresh and dried |

The difference is not small. In the FDC Snapshot, *Rice, white, long-grain, regular, raw, enriched* is 365 kcal per 100 g and 185 g a cup, about 675 kcal a cup; *Rice, white, long-grain, regular, enriched, cooked* is 130 kcal per 100 g and 158 g a cup, about 205 kcal a cup. A cup of cooked rice given the dry food would show more than three times its calories: the mirror of what the [food picks spread by preparation ADR](2026-11-12-food-picks-spread-by-preparation.md) found, where a dry-rice line given the cooked food showed about a third.

With one FDC food per Canonical Ingredient, each pair would need two Canonical Ingredients (*lemon juice* and *lemon*, *cooked rice* and *rice*). Each would be its own Grocery Item and its own chip in the Fridge, though you buy lemons and rice.

Storing the food in one place would also save nothing and break other decisions:

- **It saves no writes.** The FDC numbers are copied into each recipe, not looked up on read ([recipe data model ADR](2026-09-29-recipe-data-model.md)), so changing a Canonical Ingredient's food would still rewrite every recipe that uses it, across all its wordings, each as a new recipe version.
- **It would override Confirmed foods** in recipes the editor never opened.
- **It would cut across Confirm Batches.** A batch belongs to one recipe, and undo reverses exactly one batch on that recipe ([review items ADR](2026-11-03-review-items-and-confirm-batches.md)). A food confirmed or undone on the Canonical Ingredient from one recipe would change the conversion numbers of lines in others, outside their batches.

## Consequences

- The same Canonical Ingredient can have different FDC foods in different recipes, and in one recipe, by design.
- Drift between recipes is limited, not prevented: of the lines already matched to the Canonical Ingredient, an editor's food pick reaches only those with the same wording and exactly the same preparation ([food picks spread by preparation ADR](2026-11-12-food-picks-spread-by-preparation.md)). Lines with the same wording and no preparation always share one FDC food, so "3 sprigs thyme" and "1/2 tsp thyme" can't hold fresh and dried thyme until an editor gives one of them a preparation ("1/2 tsp thyme, dried") or a wording ("1/2 tsp dried thyme") of its own.
- The picker's default FDC food still comes from another line, as the [editors pick FDC foods ADR](2026-11-11-editors-pick-fdc-foods.md) says: after an editor matches a line to an existing Canonical Ingredient, the FDC food search's `default_fdc_id` is the food of a line anywhere in the Collection matched to it, a Confirmed one first, so an unconfirmed food is offered only when no Confirmed line has one. It ignores preparation, so a cooked-rice line may be offered dry rice, and the editor checks it.

## Considered options

- **The Canonical Ingredient owns the FDC food, and each line picks only an FDC portion:** rejected for the reasons above. It would split every pair into two Canonical Ingredients, rewrite every recipe on each change, override Confirmed foods and cut across Confirm Batches.
- **A default FDC food on the Canonical Ingredient, which a line may override:** rejected. It would save only the picker's read of the Collection, and a food pick already reads the Collection to spread itself. And it's unclear who updates it: a pick on a cooked-rice line would flip the default for all of *rice*.
- **Flag lines whose FDC food differs from the other lines of their Canonical Ingredient:** rejected, because the difference is often right, so every cooked-rice line would be flagged forever.
