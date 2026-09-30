# A recipe is one self-contained JSON item: an immutable Original, a whole-line Our Version overlay, and enrichment facts addressed by path

A recipe is stored as one JSON document, defined once as Pydantic v2 models in `backend/` with `snake_case` names. The same shape goes into DynamoDB, into the nightly JSON Lines backups and out of the API, and the TypeScript client is generated from the OpenAPI schema. The item holds everything the phone needs to scale, convert units, compute nutrition and render cooking mode **offline**, including the FoodData Central (FDC) numbers enrichment used. We chose this over storing only FDC ids and looking the numbers up when read, because the lookup would mean shipping the FDC snapshot to the PWA, and a newer FDC release would silently change recipes the [enrichment ADR](2026-09-26-enrichment-pipeline.md) says are frozen.

## Ids and layout

- **Recipe id:** an opaque ULID (`RECIPE#01J…`). The URL is `/recipes/<ulid>/<slug>`, where the slug is cosmetic: a stale slug still resolves.
- **Line and step ids:** short ids local to the recipe (`i1`, `i2`, `s1`…), assigned at ingest and never reused. Our Version additions continue the sequence. On re-ingest, a line whose text hasn't changed keeps its id, and a changed line gets a new one. Step links, the Our Version overlay, fact ids and "keep Confirmed facts on unchanged lines" all rely on these ids.
- **Components:** ingredient lines and steps are **flat lists**. Each line carries an optional `component` ("For the marinade"), and a heading is drawn wherever it changes. Nested groups were rejected, because every reader (scaling, grocery aggregation, fridge matching, work packets) would have to walk two levels and Our Version would need operations for groups.

## Facts

Every enriched fact carries `provenance` (`source` / `parser` / `fdc` / `llm` / `editor`), `confidence`, `estimated`, `confirmed`, `confirmed_by`, `confirmed_at` and `confirm_batch`. A fact is the unit an editor confirms in one tap, and its id is its **path**, so it needs no stored id:

- **Per ingredient line:** `i3.parse` (quantity, unit, unit kind, name, short name, preparation), `i3.match` (canonical ingredient id, FDC id, portion row), `i3.conversion` (density g/ml, grams per count unit, or the reason conversion is refused), `i3.substitutions`.
- **Per step:** `s2.uses` (ingredient ids with portions, adding up to at most 1 per ingredient) and `s2.segments`.
- **Per recipe:** `difficulty`, `servings`, `ratio_basis` and the parsed stated times.

Fields captured from the source (title, the as-written text) and fields only editors set (tags, preview) aren't facts. Confirming a batch of facts stamps them with one `confirm_batch` id, and so does every Enrichment Issue the batch resolves, so undo reverses exactly that batch. If the batch moved the recipe to *Ready*, undo moves it back to *Awaiting Review*.

**The FDC numbers enrichment used are copied in:** density, grams per count, and per-100 g kcal, protein, fat, carbs and sodium, for each ingredient and each substitution that differs.

## Quantities and ratio recipes

- A quantity is `{low, high}` (equal for a single value) or `null` for "to taste". Kitchen fractions are only for display.
- `amounts: "absolute" | "ratio"`. In a **Ratio Recipe** (the 27 spice blends), quantities are relative parts. `ratio_basis: "volume" | "mass"` (default volume) says what a part measures, and an optional `default_batch` is the usual **Batch Size**. A batch turns parts into amounts as `batch × part ÷ Σparts`. Without one, there's no conversion, nutrition or grocery amount.

## Step text

The Original's step `text` stays exactly as captured. Enrichment adds `segments`, the text split into typed pieces:

```json
{"id": "s4", "component": "For the sauce",
 "text": "Add 1 tsp salt and simmer 8-10 minutes at 350°F.",
 "segments": [
   {"t": "text", "v": "Add "},
   {"t": "ingredient", "ref": "i10", "written": "1 tsp salt"},
   {"t": "text", "v": " and simmer "},
   {"t": "duration", "low_s": 480, "high_s": 600, "written": "8-10 minutes"},
   {"t": "text", "v": " at "},
   {"t": "temperature", "c": 177, "written": "350°F"},
   {"t": "text", "v": "."}],
 "uses": [{"ref": "i10", "portion": 1.0}]}
```

An `ingredient` segment renders the computed amount (ingredient × portion × scale). A `duration` becomes a timer, where a range chimes at the low end and alarms at the high end. A `temperature` follows the Metric/US choice. If there are no segments yet, the raw text is shown. Character offsets into the text were rejected, because they break silently when the text is edited.

## Our Version is a whole-line overlay

```json
"our_version": {
  "ingredients": {
    "edit":   {"i4": {"text": "½ tsp salt", "parse": {…}, "match": {…}}},
    "remove": ["i9"],
    "add":    [{"id": "i11", "after": "i3", "component": "For the marinade", "text": "2 cloves garlic", …}]
  },
  "steps": {"edit": {"s3": {"text": "…", …}}, "remove": [], "add": []},
  "note": "Less salt, more garlic.",
  "edited_at": "2026-10-02T18:30:00Z"
}
```

- An edit replaces the **whole line** and gets its own facts, re-parsed on save. "Was ¾ cup" comes from comparing it with the line it replaced.
- Unchanged lines inherit the Original's facts, including Confirmed ones.
- If a re-ingest changes or removes a line that Our Version edits, the override is kept and flagged for the editor.

We rejected two alternatives. A full copy of the lists duplicates every fact, and Confirmed flags on the Original wouldn't carry over. Per-field overrides are brittle once the line's text changes.

## The rest of the recipe item

- **`source`** is a tagged union on `kind`:
  - `website`: `url`, `site_name`, `captured_at`;
  - `spreadsheet`: `url`, `sheet_id`, `entry_name`, `captured_at`;
  - `video` and `print` are later variants, added without a migration.
- **`dedupe_key`:**
  - for a website, the normalized URL (https, lower-case host, no fragment or tracking parameters, no trailing slash);
  - for a spreadsheet, `sheet_id` + `entry_name`.
- **Original:** title, description, author, `extractor` (which fallback produced it), ingredient lines, steps, `yield {text, servings, unit}` and stated times `{prep, cook, total}`, each `{text, seconds}`. The raw HTML and JSON-LD are **not** kept: they're the site's whole copyrighted page, and a re-ingest fetches the page again. Cuisine, category, keywords and the source's own ratings are dropped, since tags belong to the household.
- **Editor fields:** tags (strings, matched case-insensitively, keeping the first spelling), Difficulty, `images [{id (content hash), width, height, origin}]` and `preview {image_id, focal_x, focal_y}`. Images live at `images/<hash>.webp` in S3.
- **Enrichment:** `status` (*Pending* / *Awaiting Review* / *Ready*), `ingest_channel`, `enrichment_version`, `fdc_release`, pending flags on lines, and `issues [{id, fact_id, before, after, reason, model, status, confirm_batch}]`.
- **Not stored:** per-serving nutrition, scaled and converted amounts, grocery totals, and a "cooked N times" count. They are all derived when read.

## Other items in the table

- **Card** (`CARD`, one partition): title, site name, stated total (or prep + cook), Difficulty, tags, Enrichment Status, preview, and `needs_review {open_issues, unconfirmed}` for the "Needs Review · N" chip. A change that alters both the card and its recipe is written in one transaction.
- **Source guard** `SOURCE#<dedupe_key>`: written in the same transaction as the recipe, so a source can't be ingested twice even without an index.
- **Week Plan** `WEEK#<monday>`, created the first time something is placed in that week: `{week_start, days[7]: [{entry_id, recipe_id, recipe_title, amount}], grocery_ticks, version}`.
  - `amount` is `{kind: "scale", factor}` or, for a Ratio Recipe, `{kind: "batch", quantity, unit}`, starting from its `default_batch`.
  - A day holds any number of entries, and only their order is recorded.
  - An entry on a day that has passed counts as cooked. History is corrected by adding or removing entries.
  - `recipe_title` is copied into the entry so history survives a deleted recipe.
  - Grocery tick keys are opaque strings that grocery aggregation defines.
- **Canonical Ingredients:** one item each (`CANON`, one partition), `{id, name, family, store_category_id, pantry_staple, confirmed, version}`. Recipes point at the opaque id, so a rename touches no recipe. The **wording cache** is one item per normalized wording (`WORDING`, one partition), pointing at a canonical id. One big item for each was rejected, because every change would rewrite it and it would approach the 400 KB item limit.
- **Kitchen settings:** the ordered Store Categories, with ids. **Favorite Sites:** one item.

Deleting a recipe removes the recipe, its card and its source guard in one transaction. Nightly snapshots are the undo.

## Schema versions and migrations

Every item carries `schema_version`, and a `META#schema` item records the table's version. **Migrations are eager.** A release that changes the schema turns on a read-only "Updating…" window (reads still come from CloudFront and the offline cache). It then runs a paced `migrate` CLI, which skips items already at the target version so a half-finished run can resume, deploys the new API and turns writes back on. The API refuses to start if `META#schema` doesn't match its own version, so the code only ever handles one shape. The chain of `vN → vN+1` functions is **kept forever**: restoring a snapshot, a single recipe or Week Plan, or the staging drill reads the version from the snapshot header and upgrades each item in memory before writing it. A recipe's CloudFront cache key includes `schema_version` alongside its `version`, so phones never read an old shape with new code.

We rejected two alternatives. Upgrading on read with lazy write-back would mean the code handles more than one shape at a time. Additive-only changes with no version can't express a changed type or meaning. Expand-then-contract across two releases would avoid the window but doubles every breaking change, which isn't worth it for two editors.
