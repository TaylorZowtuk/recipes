# Research: reference data and parsers for ingredients, units, density and nutrition

Researched 2026-09-24 for the ticket "Research: reference data and parsers for ingredients, units, density and nutrition" on the map "Wayfinder: household recipe app v1 spec".

**Question.** What authoritative data and libraries can make **enrichment** trustworthy, so that volume→weight conversion and nutrition come from real data rather than invented numbers?

## Short answer

| Need | Recommendation | License | Bundle offline? |
|---|---|---|---|
| Ingredient-line parser | [`ingredient-parser-nlp`](https://github.com/strangetom/ingredient-parser) 2.8.0 (CRF model) | MIT (code, model **and** training data) | Yes, it is a pip package with the model inside |
| Units | [`pint`](https://github.com/hgrecco/pint) 0.26.1, through the unit registry and extra cooking units that `ingredient-parser-nlp` already ships | BSD | Yes |
| Density (g per cup/tbsp/each) | USDA FoodData Central **SR Legacy** `food_portion.csv` (Foundation Foods and FNDDS portions where they exist) | CC0 1.0 (public domain) | Yes: SR Legacy CSV is 6.7 MB zipped |
| Nutrition | USDA FoodData Central **Foundation Foods**, with **SR Legacy** as the fallback (per 100 g) | CC0 1.0 (public domain) | Yes: Foundation Foods CSV is 3.7 MB zipped |
| Canonical-ingredient → reference match | `ingredient-parser-nlp`'s built-in FDC matcher (`foundation_foods=True`) as the first candidate, then a household-curated override table that editors can correct | MIT, CC0 | Yes |

**Not recommended:** Open Food Facts, which covers branded products rather than generic ingredients and is ODbL share-alike. Also not the FAO/INFOODS Density Database, which is "All rights reserved" and so can't be committed to a public repo.

**Guard rail (one line):** enrichment never produces a number itself. Every gram weight or nutrient value is a lookup of `(fdc_id, portion row)` in a bundled, CC0 FDC snapshot. It is used only when the parse and the match both clear a threshold, and it is stored with its provenance and an `estimated` flag. Otherwise the original unit stays and no number is shown.

## 1. Ingredient-line parsers

### `ingredient-parser-nlp` (recommended)

- A Python package that parses an English ingredient sentence into `name`, `size`, `amount` (quantity, unit, range, approximate), `preparation`, `comment` and `purpose`. Each field has a confidence score. Version 2.8.0, MIT. Source: bundled model card `ingredient_parser/en/data/ModelCard.en.md` in the 2.8.0 wheel; [docs](https://ingredient-parser.readthedocs.io/en/latest/).
- **Model:** a Conditional Random Fields model (python-crfsuite), with rule-based pre- and post-processing. The model card states that "the model, including the training data and training scripts and python package, are released under an MIT License."
- **Stated accuracy (model card, April 2026):** **98.03 ± 0.22 % word-level** and **94.94 ± 0.51 % sentence-level**. These come from 25 train/eval cycles on an 80/20 split, so roughly 1 line in 20 has at least one token labelled wrong.
- **Training data:** NYT ingredient-phrase-tagger, Cookstr, BBC Food, AllRecipes, TasteCooking, Bon Appétit and hand-written lines. The data is mostly US-customary. The card's known limitations are consecutive numbers that should not be combined (e.g. "1 1/2-ounce steak") and long sentences, which raise the error rate.
- **Units:** returns `pint` units. The parse takes `volumetric_units_system="us_customary" | "metric" | "imperial"`, so "cup" becomes 236.6 ml, 250 ml or 284.1 ml. It ships extra pint definitions for metric/imperial/Australian/Japanese cups and spoons (`ingredient_parser/pint_extensions.txt`).
- **FDC matching:** `foundation_foods=True` returns an `FDCIngredient` match with `fdc_id`, `data_type`, `category` and a 0–1 `confidence`. It ranks about 11,100 bundled FDC entries (`fdc_ingredients.csv.gz`, which covers Foundation Foods, SR Legacy and FNDDS). Its stated caveats: it is "roughly 20x slower" and "the significance heuristic ... is unlikely to be perfect" ([docs](https://ingredient-parser.readthedocs.io/en/latest/explanation/foundation.html)). That is fine for us, because enrichment runs once per recipe at ingest.

#### Experiment (2.8.0, run locally on 2026-09-24)

| Line | Name (conf) | Amount | Prep / comment | FDC match (conf, type) |
|---|---|---|---|---|
| 2 cups all-purpose flour, sifted | all-purpose flour (0.998) | 2 cup | sifted | Flour, wheat, all-purpose, unenriched, unbleached (1.0, foundation) |
| 1 1/2 tbsp unsalted butter, melted | unsalted butter (0.999) | 3/2 tablespoon | melted | Butter, stick, unsalted (1.0, foundation) |
| 1-2 cloves garlic, finely chopped | garlic | 1–2 clove, `RANGE=True`, `quantity_max=2` | finely chopped | Garlic, raw (1.0) |
| a pinch of salt | salt (0.952) | 1 pinch (0.954) | – | Salt, table, iodized (1.0) |
| salt and pepper to taste | salt, pepper (two names) | none | comment "to taste" | Salt, table; Spices, pepper, black |
| 1 (14.5 oz) can diced tomatoes, drained | diced tomatoes | 1 can **and** 29/2 ounce | drained | Tomatoes, canned, red, ripe, diced (0.89) |
| ½ cup packed light brown sugar | light brown sugar | 1/2 cup | comment "packed" | Sugars, brown (1.0, SR Legacy) |
| 1 cup (240ml) whole milk | whole milk | 1 cup **and** 240 ml | – | Milk, whole (1.0, FNDDS) |
| 1 1/4 cups (160 g) all purpose flour | all purpose flour | 5/4 cup **and** 160 g | – | Flour, wheat, all-purpose (1.0) |
| 2 boneless skinless chicken thighs | boneless skinless chicken thighs | 2 (no unit) | – | Chicken, thigh, boneless, skinless, raw (1.0) |
| about 2 cups rice | rice | 2 cup, `APPROXIMATE=True` | – | – |
| 1 tbsp za'atar / 2 tbsp gochujang | – | – | – | **no match** (empty list) |

What this shows:
- Splitting into fields was correct on every sample line. Fractions, unicode fractions, ranges, "about", multi-name lines and dual units ("1 cup (240ml)") are all handled.
- **Recipes that state weights alongside volumes** ("(160 g)") give us a gram weight straight from the source. That beats any density lookup and should always win.
- A match with `confidence=1.0` often comes from the library's hand-written **override table** (`FOUNDATION_FOOD_OVERRIDES` in `_foundationfoods.py`, returned with `confidence=1.0`), not from the rankers. Ingredients outside the embedding vocabulary (za'atar, gochujang) return **no match** instead of a wrong one. That is the behaviour we want.
- Side effect: on first use it downloads an NLTK tagger to `~/nltk_data`. For CI and deployment, pre-fetch it at build time.

### Alternatives considered

- **Free-LLM parsing** (see the ticket on free LLM tiers). It is flexible, but its output isn't deterministic and it can invent quantities. If used at all, use it only as a fallback when the CRF parse has low confidence, and check the result against the original line (every quantity token must appear in the source text).
- **NYT `ingredient-phrase-tagger`**: the older CRF project that `ingredient-parser-nlp`'s training data partly comes from. It is archived and has no advantage here.

## 2. Units: `pint` and cooking edge cases

`pint` 0.26.1 (BSD) handles dimensional conversion and exact `Fraction` quantities. Measured edge cases:

| Case | Behaviour | What to do |
|---|---|---|
| US vs metric vs imperial cup | pint `cup` = 236.59 ml (US). `metric_cup` 250 ml and `imperial_cup` 284.13 ml come from `ingredient-parser-nlp`'s extensions | Pick `volumetric_units_system` per source (e.g. a `.co.uk` or `.com.au` site → metric/imperial) and store the system used |
| Australian tablespoon | 20 ml (`aus_tablespoon` in extensions) vs US 14.79 ml | Same: decided by the source's locale |
| "a pinch", "a dash" | **Bare pint parses `pinch` as picoinch (2.54e-14 m)**, and `dash`/`stick` are undefined | Never pass raw strings to pint. Use the parser's unit objects, or keep "pinch/dash/to taste" as **non-convertible** units that are shown as written and never scaled into grams |
| Ranges ("1-2 cloves") | Parser gives `quantity=1`, `quantity_max=2`, `RANGE=True` | Store both ends and convert or scale each end |
| Fractions ("1 1/2", "½") | Parser gives `Fraction(3,2)`, pint accepts `Fraction` | Store exact fractions and round only for display |
| "1 (14.5 oz) can" | Two amounts: 1 can + 14.5 oz | Use the mass amount for weight, and keep "can" for display |
| Count units ("3 large eggs", "2 cloves") | Unit empty or `clove` | Weight comes only from an FDC portion row for that count unit (e.g. SR Legacy garlic "1 clove = 3 g") |
| "packed" brown sugar | Comes back as a comment, not part of the unit | Density lookup must read this modifier: SR Legacy has separate "cup packed" = 220 g and "cup unpacked" = 145 g rows |

## 3. Density (grams per household measure)

There is no general "density" column in FDC. Instead, each food has **portion rows**: `amount`, `measure_unit_id`, `modifier` (free text such as "cup packed"), `gram_weight` and `data_points` (`food_portion.csv`).

Measured on the downloaded CSVs:

- **SR Legacy (April 2018, final release, frozen):** 14,449 portion rows. 7,533 of 7,793 foods have at least one portion, and **2,646 foods have a cup portion**. `measure_unit_id` is mostly `9999` ("undetermined"), so the unit sits in the free-text `modifier` ("cup", "tbsp", "cup packed", "stick", "clove", "dash") and needs a small normaliser. Samples: all-purpose flour 1 cup = 125 g; granulated sugar 1 cup = 200 g; brown sugar cup packed 220 g / unpacked 145 g; unsalted butter 1 cup = 227 g and 1 stick = 113 g; olive oil 1 cup = 216 g; table salt 1 tsp = 6 g; cocoa 1 cup = 86 g.
- **Foundation Foods (April 2026):** 395 foods, but **only 83 have portion rows** (31 with a cup portion). These use a proper `measure_unit_id` (`cup`, `tablespoon`, …) and `data_points` (e.g. table salt 1 tsp = 6.1 g, 24 data points). The flour and butter entries that the parser matched have **no portions**, so density has to fall back to the closest SR Legacy entry.
- **FNDDS (Oct 2024):** also has `food_portion` rows (household measures used for dietary surveys). The CSV is 200 MB zipped / 1.6 GB unzipped, but the JSON is only 3.7 MB zipped. Portion coverage was **not measured here**.
- **Licence:** "USDA FoodData Central data are in the public domain and they are not copyrighted", CC0 1.0; citing FDC is requested ([FDC API guide](https://fdc.nal.usda.gov/api-guide/)). Downloads: [FDC download datasets](https://fdc.nal.usda.gov/download-datasets/).

**Other density sources:**
- **FAO/INFOODS Density Database v2.0 (2012):** a good source of g/ml values, but the PDF states "© FAO 2012 ... All rights reserved ... Non-commercial uses will be authorized free of charge, upon request" ([PDF](https://www.fao.org/4/ap815e/ap815e.pdf)). It **can't be bundled in this public repo** without written permission. At most, use it as a reference when an editor adds a value by hand.
- **Baking-brand weight charts** (e.g. King Arthur's ingredient weight chart) are copyrighted editorial content, not open data. Don't scrape them into the dataset.

**Recommendation:** build a small derived table at build time, `portion_grams(fdc_id, unit, modifier, grams, source_dataset, data_points)`, from SR Legacy + Foundation Foods (+ FNDDS if coverage justifies the size), and commit it. It is CC0, so it is safe in a public repo. Add a link table, `foundation_fdc_id → sr_legacy_fdc_id`, to cover the case where the parser matches a Foundation Food that has no portions.

## 4. Nutrition

- **USDA FDC Foundation Foods** (analytical data, updated twice a year, 3.7 MB zipped CSV) and **SR Legacy** (7,793 foods, frozen 2018). Both give nutrients per 100 g in `food_nutrient.csv` and are CC0. This covers generic ingredients, which is what recipes use. **Bundle offline:** the two CSVs together are about 10 MB zipped, and only the ~11k foods the parser can match are needed.
- **FDC API:** a free api.data.gov key allows "1,000 requests per hour per IP address", and `DEMO_KEY` allows 30/hour and 50/day ([API guide](https://fdc.nal.usda.gov/api-guide/)). The API isn't needed because the data is bundled, but it is handy for looking up a food by hand.
- **Branded Foods** (FDC, 195 MB zipped JSON) and **Open Food Facts** cover packaged products by barcode. That is not what recipe lines name ("2 cups flour"), so **don't use them for v1**. Open Food Facts licensing: database ODbL, contents DbCL, images CC-BY-SA, with attribution and share-alike obligations ([OFF data](https://world.openfoodfacts.org/data)). API limits: 15 product reads/min/IP and 10 searches/min/IP, a custom User-Agent is required, and heavy users should use the daily exports ([OFF API docs](https://openfoodfacts.github.io/openfoodfacts-server/api/)). The full export is about 0.9 GB gzipped (JSONL or CSV).

Nutrition per recipe = Σ over ingredients of `grams × nutrient_per_100g / 100`. It is therefore only as good as the weakest gram estimate. Report it as a total with a coverage figure ("covers 9 of 11 ingredients") rather than silently dropping ingredients.

## 5. Matching a parsed ingredient to a reference food, and confidence

A pipeline of layers, most trusted first:

1. **Household override** (`canonical ingredient → fdc_id`, `portion row`), set by an editor. Confidence 1.0, provenance `editor`.
2. **Library override** (`ingredient-parser-nlp`'s `FOUNDATION_FOOD_OVERRIDES`, returned with `confidence=1.0`).
3. **Library ranker match**: BM25 + uSIF (GloVe) + fuzzy, fused. Keep it only if `confidence ≥ threshold`. **Start at 0.85** and tune it on a labelled sample. In the experiment, a correct ranker match scored 0.89 (canned diced tomatoes) and cilantro scored 0.95.
4. **No match** → no number. The line is kept exactly as written.

Since canonical ingredients (see `CONTEXT.md`) are already the unit of matching, cache the match **per canonical ingredient**, not per line. An editor then fixes "gochujang" once and every recipe benefits.

**Measuring confidence overall:** the combined confidence is roughly `min(parse amount conf, parse name conf, match conf)`, and there is a separate **portion-resolution** status:
- `exact`: the source stated grams/ml itself.
- `portion`: an FDC portion row with the same unit and modifier.
- `derived`: an FDC portion row for a different volume unit, scaled with pint (e.g. tbsp from cup).
- `none`.

**Evaluation:** build a labelled set of about 200 lines from the household's first ingested recipes (expected name, amount, fdc_id). Run it in CI to catch changes when `ingredient-parser-nlp` or the thresholds are upgraded. The model card itself warns that "stated performance is likely to change between releases".

## 6. Guard-rail patterns (proposed)

1. **No invented numbers.** Enrichment (including any LLM step) may pick *which* `fdc_id` / portion row applies, but every gram weight and nutrient value is read from the bundled FDC snapshot. It is never generated. An LLM suggestion must name an `fdc_id` that exists in the snapshot, or it is rejected.
2. **Convert only above threshold.** Show a converted weight (or a unit swap to grams) only when parse confidence and match confidence both clear the threshold **and** portion resolution is `exact`, `portion` or `derived`. Otherwise show the original unit unchanged. Scaling still works on the original unit.
3. **Source-stated weights win.** If the line says "(160 g)", use it and mark provenance `source`.
4. **Non-convertible units** (pinch, dash, to taste, "a handful", "1 can" without a size) are never converted to grams and never counted in nutrition.
5. **Provenance on every number.** Store `{value, unit, source: source|fdc|editor, fdc_id, dataset (foundation/sr_legacy/fndds), fdc_release, portion_modifier, data_points, match_confidence}` with the enrichment. The UI can then show "≈ 125 g · USDA FDC SR Legacy #168894 (1 cup)".
6. **"Estimated" marking.** Any number not stated by the source gets an `estimated` flag (shown as "≈"). Recipe nutrition shows coverage ("estimated from 9 of 11 ingredients").
7. **Pin the snapshot.** Record the FDC release and the parser version with each enrichment, so stored facts stay explainable after upgrades (enrichment is never recomputed silently).
8. **Editor correction loop.** A low-confidence or unmatched canonical ingredient appears in a review list. An editor's fix becomes a household override (layer 1 above).

## Sources

- `ingredient-parser-nlp` 2.8.0 wheel: `ingredient_parser/en/data/ModelCard.en.md`, `ingredient_parser/pint_extensions.txt`, `ingredient_parser/en/foundationfoods/_foundationfoods.py`, `ingredient_parser/en/data/fdc_ingredients.csv.gz`. Repo: https://github.com/strangetom/ingredient-parser. Docs: https://ingredient-parser.readthedocs.io/en/latest/ and https://ingredient-parser.readthedocs.io/en/latest/explanation/foundation.html
- `pint` 0.26.1 package metadata (BSD) and local conversions. Repo: https://github.com/hgrecco/pint
- USDA FDC API guide (rate limits, CC0): https://fdc.nal.usda.gov/api-guide/
- USDA FDC downloads (sizes, releases): https://fdc.nal.usda.gov/download-datasets/
- `FoodData_Central_sr_legacy_food_csv_2018-04.zip` and `FoodData_Central_foundation_food_csv_2026-04-30.zip`, which I downloaded and analysed locally (portion counts and sample rows above)
- FAO/INFOODS Density Database v2.0 rights statement: https://www.fao.org/4/ap815e/ap815e.pdf
- Open Food Facts data and licenses: https://world.openfoodfacts.org/data. API limits: https://openfoodfacts.github.io/openfoodfacts-server/api/
