# Recipes

A household's curated recipe collection, captured from where the recipes were found and extended with the household's own ratings, tags and adjustments.

## Language

### People

**Household**:
The couple who own the collection. There is one household, and it shares all of its data.
_Avoid_: User account, family

**Editor**:
A household member who is signed in and can change the collection.
_Avoid_: Admin, owner

**Visitor**:
Anyone viewing the collection without signing in. A visitor can read but cannot change anything. A visitor sees the household's recipes and settings as they are, but not its Week Plans or Grocery Lists: they see a Demo instead.
_Avoid_: Guest, anonymous user

**Demo**:
A made-up Week Plan and Grocery List that a visitor sees in place of the household's own, built from recipes in the collection. A visitor can change it, but the changes are never saved.
_Avoid_: Guest mode, preview, sample data

### Recipes and where they come from

**Collection**:
Every recipe the household has kept.
_Avoid_: Library, cookbook

**Recipe**:
One dish in the collection, together with everything the household has recorded about it.

**Component**:
A named part of a recipe with its own ingredients and steps, such as "For the marinade" or "For the sauce". A recipe without components has one unnamed part.
_Avoid_: Section (that word belongs to store categories), group

**Ratio Recipe**:
A recipe whose amounts are relative parts rather than quantities, such as a spice blend of 2 parts garlic powder to 1 part cumin. Its parts only become amounts once a batch size is chosen.
_Avoid_: Blend recipe, proportional recipe

**Batch Size**:
How much of a ratio recipe to make, e.g. 3 tbsp. It turns the recipe's parts into amounts.
_Avoid_: Yield (that word is for ordinary recipes), scale

**Source**:
Where a recipe originally came from. A source can be a website, a spreadsheet, a video or a printed book or page. One source can hold several recipes, such as a spreadsheet of spice blends.
_Avoid_: Origin, provider

**Ingest**:
Bringing a recipe from its source into the collection.
_Avoid_: Import, scrape (scraping is only one way to ingest)

**Enrichment**:
Structured facts added to a recipe once, after it is ingested, and stored with it. This includes parsed ingredients, substitutions, nutrition estimates and grocery categories.
_Avoid_: AI processing, augmentation

**Enrichment Status**:
Where a recipe is in enrichment: *Pending* (saved but not yet enriched), *Awaiting Review* (enriched and waiting for an editor to check it) or *Ready*. Only a Ready recipe is used for the grocery list and fridge matching.
_Avoid_: Processing state

**Enrichment Issue**:
Something enrichment corrected or was unsure about, and which an editor should check.
_Avoid_: Warning, error

**Needs Review**:
The list of open enrichment issues and unconfirmed facts, across all recipes.
_Avoid_: Inbox, queue

**Confirmed**:
Describes an enriched fact that an editor has accepted or corrected. Confirmed facts are never changed when enrichment runs again.
_Avoid_: Approved, verified

**Original**:
The recipe exactly as captured from its source. It never changes after ingest, except through a manual re-ingest that an editor has reviewed.
_Avoid_: Source version, scraped version

**Our Version**:
The household's own changes to a recipe's ingredients and steps, stored as a layer on top of the original. Each recipe has at most one.
_Avoid_: Personal adjustment, variant, fork

### Ratings and organization

**Difficulty**:
How hard a recipe is, rated separately for **Prep**, **Cook** and **Cleanup**. Each is rated 1–3. **Total Difficulty** is their sum (3–9).
_Avoid_: Effort, complexity

**Stated Time**:
The prep, cook or total time a source gives for a recipe, kept as written. It is separate from difficulty.
_Avoid_: Duration estimate

**Tag**:
A label an editor makes up and attaches to recipes so they can be filtered by it.
_Avoid_: Category (that word belongs to store categories), label

**Favorite Site**:
A recipe website the household trusts and returns to when looking for new recipes.
_Avoid_: Bookmark, source (a source is where particular recipes came from)

### Cooking and shopping

**Canonical Ingredient**:
The single name that every wording of an ingredient maps to, e.g. "boneless chicken thighs" maps to *chicken thigh*. Canonical ingredients are grouped into families, e.g. *chicken*.
_Avoid_: Normalized ingredient, food item

**Pantry Staple**:
A canonical ingredient the household always has on hand. Pantry staples are left out of grocery lists and ignored in fridge matching.
_Avoid_: Basics, essentials

**Week Plan**:
The recipes the household places on each day of one Monday-to-Sunday week. A day can be empty or hold several recipes, such as a main, a side and a sauce. Past Week Plans are kept, and a recipe on a day that has passed counts as cooked, so the plan also records what was cooked. The household corrects that record by adding or removing recipes on past days.
_Avoid_: Meal plan, menu, schedule

**Grocery List**:
The shared list of ingredients to buy, combined from the recipes in one Week Plan. Items ticked off are shared by the household.
_Avoid_: Shopping list

**Store Category**:
The aisle-style group an item appears under on the grocery list, e.g. Baking or Produce. The household can edit these groups.
_Avoid_: Section, aisle
