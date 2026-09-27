# Enrichment is deterministic first, checked by an LLM that never writes numbers

Enrichment runs after a recipe is saved, not during ingest. Deterministic code fills every field it can. An LLM then checks **every** field and fills in the ones that need judgment, but it may only **choose among options that code offers** or write text. Every density, gram weight and nutrient value comes from the bundled USDA FoodData Central (FDC) snapshot. We chose this over letting an LLM enrich freely and validating afterwards, because a model that invents a density or a calorie count produces errors that look plausible and that nobody would catch.

## Who fills what

- **Deterministic:** `ingredient-parser-nlp` and `pint` parse the quantity, unit, name and preparation. Wording → **Canonical Ingredient** mappings are cached globally, so a wording seen before maps without the LLM. Density, gram-per-count and nutrition values are looked up in a CC0 FDC snapshot that is pinned by release and bundled with the code.
- **LLM (checks everything):**
  - It may correct text-derived fields, but a corrected quantity must be readable from the line as written.
  - It picks the canonical ingredient, the `fdc_id` and the portion row from candidates offered by code, or proposes a new canonical ingredient with its family and **Store Category** chosen from the household's list.
  - It links steps to ingredients with portions, finds the durations in steps, proposes substitutions and suggests **Difficulty**.
  - It records every correction or doubt as an **Enrichment Issue**.
- **The two numbers not taken from FDC:**
  - **Step portions** are inferred by the LLM. For each ingredient they must add up to at most 1, and the default is all of it in the first step that mentions it.
  - **Substitution ratios** are proposed by the LLM, stored with provenance `llm` and marked estimated, and hidden until an editor confirms them.
- Every fact records its **provenance** (`source`, `parser`, `fdc`, `llm`, `editor`) and a confidence score, and every estimated number is shown with "≈". A volume or count converts to a weight only above the confidence threshold. Otherwise the ingredient stays in its written unit.

## Where it runs

An `enrich` CLI in the repo does the deterministic work and hands the judgment work to a model as a JSON **work packet**. It validates the answer against a schema, checking that every chosen id was one of the candidates it offered, before it writes anything. While the household has a Claude subscription, the developer runs an "enrich pending" skill in a **local Claude Code session** (Opus 5.5), which drives the CLI and summarises the issues in chat. After the subscription ends, the same packet goes to Gemini's free tier (with Groq as backup) from a scheduled Lambda, and the issues reach only the recipe and the run log. The app backend never calls Claude, because the consumer terms bar automated access.

## Review gate

A recipe moves through the **Enrichment Status** values *Pending* → *Awaiting Review* → *Ready*. Only a *Ready* recipe joins the Grocery List and fridge matching. The **ingest channel** decides whether the recipe stops at *Awaiting Review*:

- Recipes from the **bulk import** skip it and go straight to *Ready*. Their open Enrichment Issues and unconfirmed items wait in **Needs Review**, and until they're checked they behave safely: amounts stay in the written unit, substitutions stay hidden and Difficulty shows as a suggestion.
- Recipes added through **Add a recipe** wait in *Awaiting Review* until an editor has checked the whole enrichment.

A fact an editor accepts or corrects becomes **Confirmed**.

## What is frozen and what is recomputed

- **Frozen:** the Original, Confirmed facts, and the FDC snapshot the recipe was enriched against.
- **Never stored, so always current:** per-serving nutrition, scaled and converted amounts, and grocery totals. These are computed when read.
- **Re-enrichment** is an explicit command, never automatic. It shows what it would change before writing and never touches Confirmed facts. Each recipe records its enrichment version and snapshot release, so recipes that are out of date can be found.
- **Our Version:** saving Our Version runs the deterministic path on new or changed lines at once. Lines it can't resolve are marked pending, but the recipe stays *Ready*, and those lines appear on the Grocery List as written under "Other".
- **Re-ingest:** a reviewed re-ingest re-enriches the Original and keeps Confirmed facts wherever the ingredient line hasn't changed.

## Considered options

- **The LLM enriches everything and code validates it afterwards:** rejected, because the numbers would come from the model.
- **Deterministic only, with editors doing the judgment by hand:** rejected, because it is too much manual work for the initial collection.
- **Enrichment on every save through Gemini in a Lambda from day one:** deferred as the fallback, because Claude Code gives better judgment at no extra cost while the subscription lasts.
- **A scheduled cloud Claude Code routine:** rejected, because it needs stack credentials in the cloud and comes close to the automated-access limit in the consumer terms.
- **Seeding canonical ingredients from FDC food names:** rejected, because the names are awkward and there are far too many of them. The table grows through enrichment instead.
