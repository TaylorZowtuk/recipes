# The Grocery List is computed on the phone, one Grocery Item per Canonical Ingredient, and a tick records the amount it was ticked at

A Week Plan's Grocery List is never stored. The frontend computes it with one pure TypeScript function over the Week Plan, its recipe items, the Canonical Ingredients and Kitchen settings. It works offline, because the [data model](2026-09-29-recipe-data-model.md) already copies every conversion number into the recipe. We rejected computing it in the API, because the list then wouldn't work offline. We rejected having both the API and the phone compute it, because two implementations would drift apart. Only the ticks and the Extras are stored, on the Week Plan item.

## What goes in

- Every entry on all seven days counts, past days included, and a recipe planned twice counts twice.
- Each recipe contributes its **effective lines**: the Original with Our Version applied.
- Only *Ready* recipes are included. A banner names any recipe on the plan that isn't *Ready* yet and links to it.
- On a *Ready* recipe, a line that is pending or has no Canonical Ingredient becomes its own item under **Other**, as written, labelled with its recipe.

## Amounts

- **Scale entry:** every line × `factor`.
- **Batch entry (Ratio Recipe):** `batch × part ÷ Σparts`, in the kind that `ratio_basis` names. The batch picker only offers units of that kind. Placing a Ratio Recipe that has no `default_batch` asks for a batch, so an entry never lacks one.

## Merging into one Grocery Item per Canonical Ingredient

Merging is by Canonical Ingredient, not by family, so *chicken thigh* and *chicken breast* stay apart.

1. **Same kind** (volume, mass or plain count): summed exactly with unit arithmetic. No confidence is involved.
2. **Different kinds:** if every contributing line has a conversion fact above the confidence threshold, everything becomes **mass**, shown with "≈" if any of it is estimated. Otherwise the item keeps one subtotal per kind: "2 cups + 300 g".
3. **Sized counts** (`can (14 oz)`) stay as packages, because that's what is bought. Packages of the same size add up, and different sizes are separate subtotals. They're never converted to mass.
4. **Ranges** sum their lows and highs separately and show as a range.
5. **"To taste"** (null quantity) lines stay in their Store Category as an item with no amount ("parsley · to taste"). Where the item also has amounts, the "to taste" line adds nothing to it. It doesn't go under Other: Other means "unresolved", and a "to taste" line is resolved.
6. **Display unit:** the unit of the largest contribution, rounded to a friendly unit in the same system (48 tsp → 1 cup). The Metric/US choice applies only when the device has it set away from "as written". Expanding an item shows each recipe and day with that recipe's own amount.

## Layout

- Items are grouped under Store Categories in the household's order, alphabetical within a category, with **Other** last.
- A ticked item sinks to the bottom of its category.
- Pantry Staples are left out. A collapsed footer lists the ones left out, and tapping one adds it back as an Extra.

## Tick keys

`grocery_ticks` is a set of opaque strings (atomic set updates, per the [source-of-truth ADR](2026-09-27-dynamodb-source-of-truth-and-backups.md)). A tick is `<item key>|<amount fingerprint>`:

- **Item keys:**
  - `c:<canonical_id>` for a merged item;
  - `o:<entry_id>:<line_id>` for an Other line, since Other lines don't merge and a recipe can appear twice in a week;
  - `x:<extra_id>` for an Extra.
- **Amount fingerprint:** the item's summed amount in canonical form (for example `count:2`, or `ml:473+g:300`). If an item has no amount, the fingerprint is empty.

If the plan changes and an item's total no longer matches its tick, the item shows as **unticked**, with "2 ticked earlier". If the total goes back to the old amount, the old tick matches again. Ticks whose item has left the list stay in the set and are ignored. Pruning them would race with the other phone, and they're tiny. A correction that moves a line to a different Canonical Ingredient changes its key, so that tick is lost.

We rejected keying ticks on the item alone. It's simpler, but a tick would survive a recipe being added, and "onion · 2" ticked before a third onion was needed would send you home one short. A tick answers "have I bought *this much*?"

## Extras

The Week Plan item gains `grocery_extras: [{id, text, canonical_id | null, store_category_id}]`, written conditionally on the plan's `version` like the rest of the plan.

- The text is matched through the wording cache. If it matches a Canonical Ingredient, the Extra takes that ingredient's category and merges into its item, shown as "+ added".
- Otherwise the category comes from the enum-constrained LLM call, then the dropdown, as the [free-LLM research](https://github.com/TaylorZowtuk/recipes/issues/5) set out.
- An Extra has no amount of its own. The text says it if it matters ("2 L olive oil").

## Kitchen settings

- **Store Categories:** add, rename, drag to reorder, delete. Deleting one asks which category its Canonical Ingredients move to, and the last category can't be deleted. The page uses the batched Edit → "Save N changes" pattern.
- **Pantry Staples:** a searchable list of every Canonical Ingredient with a staple toggle, on the same page.
- **From the list:** a Grocery Item's action sheet has "Always have this (pantry staple)" and "Move to category…". Both change the Canonical Ingredient for every week, apply immediately and show an Undo toast.
- **Seed categories**, in store order: Household · Produce · Meat · Aisles · Spices · Dairy · Frozen · Bakery. Seafood goes under Meat, eggs under Dairy, and "Aisles" holds the centre of the store (canned, baking, condiments, drinks, dry goods). The seed must exist before the first bulk import, because enrichment picks a new Canonical Ingredient's category from this list.
