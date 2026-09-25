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
Anyone viewing the collection without signing in. A visitor can read but cannot change anything.
_Avoid_: Guest, anonymous user

### Recipes and where they come from

**Collection**:
Every recipe the household has kept.
_Avoid_: Library, cookbook

**Recipe**:
One dish in the collection, together with everything the household has recorded about it.

**Source**:
Where a recipe originally came from. A source can be a website, a video or a printed book or page.
_Avoid_: Origin, provider

**Ingest**:
Bringing a recipe from its source into the collection.
_Avoid_: Import, scrape (scraping is only one way to ingest)

**Enrichment**:
Structured facts added to a recipe once, when it is ingested, and stored with it. This includes parsed ingredients, substitutions, nutrition estimates and grocery categories.
_Avoid_: AI processing, augmentation

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
_Avoid_: Bookmark, source (a source belongs to one recipe)

### Cooking and shopping

**Canonical Ingredient**:
The single name that every wording of an ingredient maps to, e.g. "boneless chicken thighs" maps to *chicken thigh*. Canonical ingredients are grouped into families, e.g. *chicken*.
_Avoid_: Normalized ingredient, food item

**Pantry Staple**:
A canonical ingredient the household always has on hand. Pantry staples are left out of grocery lists and ignored in fridge matching.
_Avoid_: Basics, essentials

**Grocery List**:
The single shared list of ingredients to buy, combined from the recipes chosen for the week.
_Avoid_: Shopping list

**Store Category**:
The aisle-style group an item appears under on the grocery list, e.g. Baking or Produce. The household can edit these groups.
_Avoid_: Section, aisle
