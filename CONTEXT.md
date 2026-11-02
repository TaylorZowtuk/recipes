# Recipes

A household's curated recipe collection, captured from where the recipes were found and extended with the household's own ratings, tags and adjustments.

## Language

### People

**Household**:
The couple who own the collection. There is one household, and it shares all of its data.
_Avoid_: User account, family

**Editor**:
A household member who is signed in, or a local CLI sending the Service Token, and can change the collection.
_Avoid_: Admin, owner

**Editor Allowlist**:
The emails of a stack's editors, kept in that stack's SSM parameters. Someone who signs in with Google is an editor only if their email is on it.
_Avoid_: Whitelist, user list

**Service Token**:
A permanent token per stack that local CLIs send in a header instead of signing in. The API treats a match as an editor.
_Avoid_: API key, password

**Visitor**:
Anyone viewing the collection without signing in. A visitor can read but cannot change anything. A visitor sees the household's recipes and settings as they are, but not its Week Plans or Grocery Lists: they see a Demo instead.
_Avoid_: Guest, anonymous user

**Demo**:
A made-up Week Plan and Grocery List that a visitor sees in place of the household's own, built from recipes in the collection. A visitor can change it, but the changes are never saved.
_Avoid_: Guest mode, preview (that word belongs to the Preview Photo), sample data

### Recipes and where they come from

**Collection**:
Every recipe the household has kept.
_Avoid_: Library, cookbook

**Recipe**:
One dish in the collection, together with everything the household has recorded about it.

**Card**:
A recipe's summary in the collection grid: its title, source site, a single total time taken from the Stated Times (the stated total, or else prep plus cook), Difficulty, tags, Enrichment Status, Preview Photo (or the Empty Plate) and its counts for Needs Review. A card is always derived from its recipe and changes whenever the recipe does.
_Avoid_: Tile, summary, listing

**Candidate Photo**:
A photo found on a recipe's Source during ingest, stored in the images bucket and offered to the editor to pick from. Every candidate that stores is kept with the recipe, including those not picked; one that fails to store is dropped.
_Avoid_: Thumbnail, scraped image

**Preview Photo**:
The one Candidate Photo an editor picks to show a recipe, cropped round on its card and recipe header. A recipe may have none.
_Avoid_: Cover photo, hero image, thumbnail

**Focal Point**:
The point of the Preview Photo that its round crop keeps in view, given as fractions of the photo's width and height; the crop places it at the same fractions across and down the plate. The crop is worked out when the photo is shown and never stored.
_Avoid_: Crop, centre

**Empty Plate**:
What a card or recipe header shows in place of a Preview Photo when the recipe has none: an empty plate with the recipe's initial.
_Avoid_: Default image, blank photo

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

**Queued Ingest**:
A website Source that Add a recipe couldn't turn into a recipe with a plain fetch, kept so the Source stays reserved. It is either *waiting* for the local fallback chain or *needs a page*, where an editor has to paste the page or its text. It isn't a recipe and has no card. It has nothing to do with the Enrichment Status *Pending*, which is a saved recipe waiting for enrichment.
_Avoid_: Pending ingest (*Pending* is an Enrichment Status), draft, failed import

**Source Guard**:
The record that a Source is already in the collection, which stops it being ingested twice. It points at either a recipe or a Queued Ingest, and is checked before anything is fetched.
_Avoid_: Duplicate check, dedupe index

**Enrichment**:
Structured facts added to a recipe once, after it is ingested, and stored with it. This includes parsed ingredients, substitutions, nutrition estimates and grocery categories.
_Avoid_: AI processing, augmentation

**Substitution**:
A substitute for an ingredient line that the recipe itself states, such as "butter or margarine", with an estimated ratio and the FDC numbers for the substitute. Enrichment records only what the recipe states, as unconfirmed, and a household's own substitutions go in Our Version. Only a Confirmed substitution is used: fridge matching then shows a **swap**. The stored fact is a Substitution; "swap" is only how fridge matching shows one.
_Avoid_: Swap (for the stored fact), alternative, replacement

**Fact**:
One piece of enrichment that an editor confirms in one tap, such as an ingredient line's parse (its quantity, unit, name and preparation). It records its provenance (source, parser, FDC, LLM or editor), a confidence and whether it is estimated. Each fact belongs to one ingredient line, one step or the recipe. Facts are kept apart from the Original.
_Avoid_: Annotation, field

**Enrichment Version**:
The version of enrichment a recipe was enriched with, recorded on the recipe so out-of-date recipes can be found for re-enrichment.
_Avoid_: Enrichment run, parser version

**Ingest Channel**:
How a recipe came into the collection: *Add a recipe*, where an editor adds one from a website, or the *bulk import*. It decides whether enrichment stops at *Awaiting Review* (Add a recipe) or goes straight to *Ready* (bulk import).
_Avoid_: Origin, import type

**Enrichment Status**:
Where a recipe is in enrichment: *Pending* (saved but not yet enriched), *Awaiting Review* (enriched and waiting for an editor to check it) or *Ready*. Only a Ready recipe is used for the grocery list and fridge matching.
_Avoid_: Processing state

**Enrichment Issue**:
Something enrichment corrected or was unsure about, and which an editor should check. It names the fact it is about, what it was before and after, and the reason.
_Avoid_: Warning, error

**Work Packet**:
The JSON that enrichment hands a model for every Pending recipe: each ingredient line with its parse, the numbers a quantity can be read as from it, and the Canonical Ingredients and FDC foods (with their portions) it may choose among; and each step's text, the durations and temperatures code found in it, each with an id, and default uses. The answer keeps those that really are durations and temperatures, and gives each phrase in a step that names an ingredient line, with its Step Portion. The model's answer is checked against the packet, and a recipe whose answer chose anything it wasn't offered, or whose offer changed since the packet was made, is not written.
_Avoid_: Prompt, batch

**Step Portion**:
The share of an ingredient line that one mention of it in a step uses, e.g. 0.5 for "half the garlic". The step shows the line's amount times it. Across all of a recipe's steps, a line's step portions add up to at most 1. It has nothing to do with an FDC food's portion, a household measure with its gram weight.
_Avoid_: Portion (alone), share, fraction

**FDC Snapshot**:
The pinned copy of USDA FoodData Central's Foundation Foods and SR Legacy kept in the repo, which every density, gram weight and nutrient value comes from. Its release is recorded on each recipe enriched with it.
_Avoid_: Nutrition database, USDA API

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

**Suggested Difficulty**:
The Difficulty that enrichment guesses for a recipe, stored as its own unconfirmed fact apart from the editor's Difficulty. The card and recipe view show it, labelled as a suggestion, and the card's Difficulty filters use it, only while the editor hasn't set a Difficulty. Confirming it makes it the recipe's Difficulty.
_Avoid_: Auto difficulty, estimated difficulty

**Stated Time**:
The prep, cook or total time a source gives for a recipe, kept as written. It is separate from difficulty.
_Avoid_: Duration estimate

**Tag**:
A label an editor makes up and attaches to recipes so they can be filtered by it. Tags match case-insensitively across the Collection and keep the spelling first used, so "WEEKNIGHT" on a new recipe becomes the Collection's "weeknight".
_Avoid_: Category (that word belongs to store categories), label

**Draft**:
An editor's unsaved changes while editing a saved recipe, such as its Difficulty, Tags and Preview Photo. It is held only in the recipe page, never stored or sent until the editor saves it as one batch with "Save N changes", and Cancel or leaving the page discards it. A Queued Ingest is not a draft: it is a Source waiting to become a recipe.
_Avoid_: Pending changes (*Pending* is an Enrichment Status), unsaved edit

**Favorite Site**:
A recipe website the household trusts and returns to when looking for new recipes.
_Avoid_: Bookmark, source (a source is where particular recipes came from)

### Cooking and shopping

**Canonical Ingredient**:
The single name that every wording of an ingredient maps to, e.g. "boneless chicken thighs" maps to *chicken thigh*. Each one belongs to a **family**, a lowercase word that groups canonical ingredients, e.g. *chicken* for *chicken thigh* and *chicken breast*, and to a Store Category. Enrichment creates them; an editor confirms them.
_Avoid_: Normalized ingredient, food item

**Wording Cache**:
What enrichment has learned about which Canonical Ingredient each wording of an ingredient means, keyed by the wording in lowercase with its spacing and surrounding punctuation tidied ("Stewing  Beef." is *stewing beef*). Enrichment offers a cached wording's Canonical Ingredient first and the model still checks it; once an editor confirms the wording, it is the only one offered and enrichment never changes it.
_Avoid_: Alias table, synonym list

**Pantry Staple**:
A canonical ingredient the household always has on hand. Pantry staples are left out of grocery lists and ignored in fridge matching.
_Avoid_: Basics, essentials

**Fridge**:
The canonical ingredients someone has said they have right now, used to find recipes they can cook. Each phone keeps its own, and it isn't shared with the household.
_Avoid_: Inventory, pantry

**Week Plan**:
The recipes the household places on each day of one Monday-to-Sunday week. A day can be empty or hold several recipes, such as a main, a side and a sauce. Past Week Plans are kept, and a recipe on a day that has passed counts as cooked, so the plan also records what was cooked. The household corrects that record by adding or removing recipes on past days.
_Avoid_: Meal plan, menu, schedule

**Grocery List**:
The shared list of ingredients to buy, combined from the recipes in one Week Plan, plus any extras. Items ticked off are shared by the household.
_Avoid_: Shopping list

**Grocery Item**:
One row on a Grocery List, and the thing that's ticked off. It combines every recipe's need for one canonical ingredient, including recipes that say only "to taste". A recipe line that couldn't be matched to a canonical ingredient becomes its own item under "Other", as written.
_Avoid_: Line (a line belongs to a recipe), entry (an entry belongs to a Week Plan)

**Extra**:
A Grocery Item an editor adds by hand to one week's Grocery List, such as paper towels or a pantry staple that has run out.
_Avoid_: Custom item, manual item

**Store Category**:
The aisle-style group a Grocery Item appears under on the grocery list, e.g. Produce or Spices. The household can edit these groups.
_Avoid_: Section, aisle

**Kitchen settings**:
The household's shared settings for its kitchen, such as the Store Categories and their order. A new collection starts with Household, Produce, Meat, Aisles, Spices, Dairy, Frozen and Bakery.
_Avoid_: Preferences, config
