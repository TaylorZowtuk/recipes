# Research: scraping website recipes in Python

Answers the ticket "Research: scraping website recipes in Python" (wayfinder map: household recipe app v1 spec). Researched on 2026-09-24.

> **Still to do:** "Collect the recipe sources into one file" has not landed yet, so this uses a representative set of popular sites instead of the household's real ones. Once that file exists, re-run the spot-check (method in the Appendix) against the household's own website sources.

## Short answer

**Recommended:** fetch the page ourselves, then parse it with **`recipe-scrapers`** (`scrape_html(html, org_url=url, supported_only=False)`). The library tries a site-specific scraper first and falls back to generic schema.org `Recipe` parsing. When we fetch, we:

- send an honest User-Agent,
- make one request per ingest,
- check robots.txt with an RFC 9309 parser (`protego`),
- throttle requests per host.

When we store the **original**, we keep the **raw schema.org values** next to the parsed ones. This matters most for **stated times** and yield, because the library's normalised values lose information.

We download the chosen image once, at ingest, re-encode it to WebP (long edge about 1600 px, plus a smaller variant), and store it outside the public repo.

**Fallbacks, in order:**

1. **Page loads but has no or incomplete `Recipe` data:** use LLM extraction from the page text, and have an editor review the result.
2. **Page is blocked (403, bot challenge):** have the editor supply the page instead. On desktop, a bookmarklet that posts the page's `outerHTML` runs through the same parser. On phones, pasting the text goes through LLM extraction.
3. **Headless browser (Playwright):** optional. It fixed some blocks but not Cloudflare-challenged sites, and it is heavy for free hosting.

**Seam:** keep the two stages separate. A **source adapter** turns a source into a captured document (HTML, text, later a transcript or photo). An **extractor** turns that document into the original. Websites are just the first adapter, so video and paper can be added later as new adapters that feed the LLM extractor.

## 1. `recipe-scrapers`

### What it is and whether it's maintained

- **Repo:** `hhursev/recipe-scrapers`, MIT licence, not archived, about 2.2k stars, 136 open issues. The last push was on 2026-09-09. ([GitHub API, repos/hhursev/recipe-scrapers](https://github.com/hhursev/recipe-scrapers))
- **Release cadence:** releases come roughly every one to three months. The latest is **15.12.0 (2026-08-08)**; before that came 15.11.0 (2025-12-10), 15.10.0 (2025-11-12) and 15.9.0 (2025-08-09). ([GitHub releases](https://github.com/hhursev/recipe-scrapers/releases))
- **Python and dependencies:** requires Python >= 3.10. Its core dependencies are `beautifulsoup4`, `extruct` and `isodate`. `requests` is only an optional `[online]` extra. ([PyPI metadata](https://pypi.org/project/recipe-scrapers/))
- **Verdict:** actively maintained, with a small dependency footprint. Pin the version, and expect site scrapers to need upgrades as sites change.

### Which sites it supports

- **Size:** the `SCRAPERS` registry in 15.12.0 has **725 host names**. Some scraper classes cover several domains. (`recipe_scrapers/__init__.py`, `SCRAPERS`; list: [docs: Supported Sites](https://docs.recipe-scrapers.com/getting-started/supported-sites/))
- **Coverage:** it covers big publishers (e.g. Allrecipes, BBC Good Food, NYT Cooking, Bon Appétit, Food Network, Serious Eats, King Arthur, Taste of Home, Delish, Pioneer Woman, Jamie Oliver) and many WordPress food blogs.
- **WP Recipe Maker:** there is a shared helper for the WP Recipe Maker plugin (`_wprm.py`), which many food blogs use.
- **Checking a URL:** `scraper_exists_for(url)` tells you whether a site-specific scraper exists.

### How the generic schema.org fallback works

These points come from reading `scrape_html` in `recipe_scrapers/__init__.py` (15.12.0):

- **Matching:** if the URL's host is in `SCRAPERS`, the site-specific class is used. That class usually still reads schema.org first and adds HTML selectors where the site's markup is weak.
- **`supported_only=True` (the default):** an unknown host raises `WebsiteNotImplementedError`.
- **`supported_only=False`:** an unknown host is handled by `SchemaScraperFactory.SchemaScraper` (`_factory.py`), which reads only schema.org data. If none is found, it raises `NoSchemaFoundInWildMode`.
- **Where the data is read from:** schema.org data is extracted with `extruct` from **JSON-LD and microdata** (`_schemaorg.py`, `SYNTAXES = ["json-ld", "microdata"]`). RDFa is not read.
- **Gaps are filled from other sources:** plugins fill missing fields from OpenGraph, e.g. `og:image` (`settings/default.py`, `PLUGINS`: `OpenGraphImageFetchPlugin`, `OpenGraphFillPlugin`, `SchemaOrgFillPlugin`).
- **Deprecated options:** the `online=True` and `wild_mode` options are deprecated. The library's own warning says to "use an HTTP client (such as 'requests' or 'httpx') to retrieve the recipe's HTML", then call `scrape_html(html, org_url=...)`. **This is what we want anyway:** fetching and parsing stay separate, so any HTML (fetched, from a headless browser, or pasted by an editor) goes through the same parser.
- **Built-in User-Agent:** the library's User-Agent is `Mozilla/5.0 (compatible; ...) recipe-scrapers/<ver>` (`_abstract.py`, `HEADERS`).

### Where its normalised values lose information (this matters for stated times)

- **Times:** `total_time()`, `prep_time()` and `cook_time()` return **integer minutes**.
  - If `totalTime` is missing, `total_time()` returns **prep + cook**, which is a computed number, not the stated time (`_schemaorg.py`).
  - For a range such as "12-15 minutes", `get_minutes` keeps only the upper bound (`_utils.py`).
- **Observed: Bon Appétit.** The page's JSON-LD had `totalTime: "40 minutes"`, which is valid text but not ISO 8601. `total_time()` returned `None`, even though `cook_time()` parsed `"20 minutes"`.
- **Observed: Taste of Home.** `recipeYield: "2 potpies (8 servings each)"` became `yields() == "2 servings"`.
- **Consequence for the data model:** store the **raw** `prepTime`, `cookTime`, `totalTime` and `recipeYield` exactly as written. The raw values are available as `scraper.schema.data`. Also store the parsed minutes for sorting and filtering. This is the "kept as written" rule in the CONTEXT.md definition of **stated time**, and it is input for "Define the recipe data model and file format".

## 2. How widely sites publish schema.org `Recipe` data, and which fields we can rely on

**Why sites publish it:** Google's recipe rich results need `Recipe` structured data. That gives publishers a strong incentive to include it.

- **Required by Google:** only `name` and `image`.
- **Recommended by Google:** `recipeIngredient`, `recipeInstructions`, `prepTime`, `cookTime`, `totalTime`, `recipeYield`, `nutrition.calories`, `author`, `description`, `keywords`, `recipeCategory`, `recipeCuisine`, `aggregateRating`, `video` and `datePublished`.

([Google Search Central: Recipe structured data](https://developers.google.com/search/docs/appearance/structured-data/recipe), last updated 2026-09-08)

**Schema.org definitions:**

- The fields are defined on [schema.org/Recipe](https://schema.org/Recipe).
- Times are `Duration` values in [ISO 8601 duration format](https://schema.org/Duration), e.g. `PT1H15M`, but real pages also contain plain text (see Bon Appétit above).
- `recipeYield` may be text or a quantity, and in practice it is often a list such as `["4", "4 servings"]`.

**Spot-check (2026-09-24):** 20 pages from 20 popular sites were tested. 16 returned a page: 15 recipe pages plus one article page. The other 4 were blocked (see §4).

| Field | Present, out of 15 reachable recipe pages | Notes |
|---|---|---|
| `Recipe` schema at all | 14 JSON-LD + 1 microdata-only (Smitten Kitchen) | The Kitchn article page tested had only `Article` markup, with no `Recipe` |
| `recipeIngredient` | 15/15 | Plain strings, not parsed (parsing is enrichment) |
| `recipeInstructions` | 14/15 | Smitten Kitchen's microdata had none, so 0 steps |
| `image` | 14/15 in schema, 15/15 after the OpenGraph fill | Often 3–4 variants (different aspect ratios) |
| `totalTime` | 14/15 | Epicurious had no times at all; Bon Appétit used non-ISO text ("40 minutes"); Smitten Kitchen used `P0DT0H50M0S` |
| `prepTime` | 10/15 | Often missing (NYT, Bon Appétit, Jamie Oliver, Smitten Kitchen) |
| `cookTime` | 11/15 | Delish had `PT0S` for a no-cook recipe |
| `recipeYield` | 15/15 | Free text; wording varies a lot |
| `nutrition` | 11/15 | Strings like "120 calories". Treat these as the site's claim, not as ground truth (see the enrichment guard rails) |

**What we can rely on:**

- **Reliable:** title, ingredients (as strings) and one image.
- **Usually present:** instructions and yield.
- **Often missing, so they must be optional:** each individual **stated time** and nutrition. The Original must allow any stated time to be absent, and must not make one up.

## 3. Images: downloading, sizes, format

**Which image the library picks:** with `best_image` on (the default, `settings/default.py`, `BEST_IMAGE_SELECTION = True`), `image()` picks the best of the listed images. Google asks publishers for high-resolution images in 16x9, 4x3 and 1x1 ratios, so there are often several to choose from ([Google docs](https://developers.google.com/search/docs/appearance/structured-data/recipe), `image`).

**Measured images:** we downloaded the image `image()` picked for six sites and re-encoded it with Pillow (`quality=80, method=6`):

| Site | Source | Size | WebP, long edge ≤1600 | WebP, long edge ≤800 |
|---|---|---|---|---|
| Bon Appétit | JPEG 4800×2700 | 1692 KB | 177 KB | 46 KB |
| King Arthur | JPEG 1248×832 | 199 KB | 127 KB | 56 KB |
| RecipeTin Eats | JPEG 1200×1500 | 174 KB | 170 KB | 101 KB |
| Budget Bytes | JPEG 800×600 | 101 KB | 100 KB | 100 KB |
| Pioneer Woman | JPEG 808×800 | 98 KB | 69 KB | 64 KB |
| BBC Good Food | JPEG 440×400 | 34 KB | 22 KB | 22 KB |

**Recommendation:**

- **When:** download once, at ingest.
- **Variants:** store two WebP variants, ~1600 px for the recipe view and ~600–800 px for the browse grid. Never upscale. If the WebP isn't smaller, keep the original bytes.
- **Tools:** Pillow in the installed wheel supports WebP and AVIF ([Pillow image formats: WebP](https://pillow.readthedocs.io/en/stable/handbook/image-file-formats.html)). Use `Image.thumbnail`, which preserves the aspect ratio. Convert to RGB, and handle the EXIF orientation with `ImageOps.exif_transpose`.
- **Budget:** plan for about **100–250 KB per recipe** for both variants.
- **Where to store:** images are other people's copyrighted work, so they **must not go in the public repo**. Store them in the image storage chosen by "Research: free hosting for a Python backend, a TypeScript PWA and image storage". Record the source image URL in the original.
- **Also keep:** the source page URL and the date it was captured.

## 4. When a site can't be scraped

**What we observed** (2026-09-24, from a residential IP):

| Failure | Sites | Plain HTTP | Headless Chromium (Playwright) |
|---|---|---|---|
| Cloudflare bot challenge ("Just a moment…" / 403) | Allrecipes, Serious Eats, Simply Recipes (all Dotdash Meredith) | 403 with every User-Agent tried | **Still 403** (challenge page) |
| Blocks a **spoofed browser** User-Agent, allows honest ones | Budget Bytes | 403 with a Chrome User-Agent; **200** with the library's User-Agent or `household-recipes/0.1 (+repo URL)` | not needed |
| Edge or bot filtering | Food Network | 403 | **200, parsed fine** (11 ingredients, total 110 min) |
| No or partial schema | Smitten Kitchen (microdata only, no instructions); The Kitchn article (no `Recipe`) | 200 | Doesn't help, because the data isn't there |
| Paywall | NYT Cooking | 200, and the JSON-LD was complete for the recipe tested | n/a |

**What this means:**

- **Don't pretend to be a browser.** An honest, identifiable User-Agent did better than a fake Chrome one.
- **Don't try to get around bot challenges.** A headless browser is not a reliable fix for Cloudflare-managed sites, and defeating their challenge is not something to build on.
- **Playwright** ([docs](https://playwright.dev/python/docs/intro)) needs a ~115 MB Chromium download and a lot of memory, which makes it hard to fit on free hosting. Treat it as optional. At most, run it on demand somewhere cheap, e.g. on an editor's machine or in a GitHub Actions job.
- **The robust fallback is for the editor to supply the page content**, since their own browser has already passed any challenge:
  - **Desktop bookmarklet:** it sends `document.documentElement.outerHTML` and the URL to the app's ingest endpoint. That HTML includes the JSON-LD, so `scrape_html` handles it exactly as if we had fetched it.
  - **Android:** the PWA's Web Share Target can receive a shared URL, which still leaves the fetch to us. Web Share Target is supported on Chrome Android (76+) but **not on iOS Safari or Firefox Android** ([MDN browser-compat-data 8.1.3](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/share_target)).
  - **iPhone:** the realistic fallback is **paste the recipe text**, followed by LLM extraction into the same original shape, with editor review. Which model to use comes from "Research: free LLM options for ingest and runtime". The enrichment guard rails ("Design the enrichment pipeline and its guard rails") apply to anything the LLM produces.
- **Partial schema** (e.g. no instructions) also goes through LLM extraction on the page text. The schema fields it does have are passed in as fixed values the LLM must keep.

## 5. Polite scraping

**Scale:** our pattern is **one editor-initiated fetch per recipe**, plus a rare manual re-ingest. That is far from crawling, but we should still behave like a good citizen:

- **robots.txt:** honour it with a parser that follows **RFC 9309** ([RFC 9309](https://www.rfc-editor.org/rfc/rfc9309)).
  - Use `protego` ([repo](https://github.com/scrapy/protego)), which supports `*` and `$` wildcards.
  - **Don't use the stdlib `urllib.robotparser`.** In testing it:
    - reported Bon Appétit's recipe URL as disallowed because it can't handle wildcard rules (`Disallow: /*?`),
    - treated a failed robots.txt fetch as "disallow everything", because it treats 401/403 that way ([CPython source](https://github.com/python/cpython/blob/main/Lib/urllib/robotparser.py)).
  - **RFC 9309 says otherwise:** a 4xx on robots.txt means the crawler "MAY access any resources" (§2.3.1.3).
  - **Cache robots.txt** for at most 24 hours (§2.4).
- **User-Agent:** send an identifying one with a contact URL, e.g. `household-recipes/0.1 (+https://github.com/TaylorZowtuk/recipes)`.
- **Rate limits:**
  - Allow at most one request in flight per host.
  - Wait at least ~5 s between requests to the same host (honour `Crawl-delay` if one is set; none of the sites tested set one).
  - On `429` or `503`, back off exponentially and honour `Retry-After`. Smitten Kitchen returned a 429 to a spoofed User-Agent during testing.
- **Timeouts and retries:** use a ~20 s timeout and no automatic retries on 403.
- **Fetch once:** never re-fetch automatically. The original never changes after ingest, except through a manual re-ingest that an editor has reviewed. So there are no background refreshes, and no need for them.

## 6. The seam for sources that aren't websites

The pipeline has three stages:

```
SourceAdapter            ->  CapturedDocument           ->  Extractor(s)              ->  Original
 website (fetch URL)         { kind: html|text|image|      schema.org (recipe-scrapers)   + stated times raw
 editor paste/bookmarklet      transcript, content,        LLM extraction (fallback)      + provenance
 later: video, paper           source url/ref, captured_at }
```

- **What makes the seam clean:** `recipe-scrapers` takes an **HTML string**, not a URL it fetches itself. That keeps fetching (a website detail) separate from extraction.
- **Adding video later:** a transcript or description adapter produces `text`.
- **Adding paper later:** a photo or OCR adapter produces `image`/`text`.
- **No other changes:** both feed the same LLM extractor and the same original shape. Nothing downstream needs to know which kind of source a recipe came from, beyond the provenance recorded on the original.

## Appendix: spot-check method (re-run against the household list)

The experiment was run in a scratch virtual environment. No code was committed.

**Setup:**

- `recipe-scrapers==15.12.0`, `extruct`, `protego`, `Pillow`, and `playwright` with Chromium headless shell 153.
- For each URL:
  1. check robots.txt with `protego`,
  2. `requests.get` with an honest User-Agent,
  3. find the `Recipe` in the `extruct` JSON-LD or microdata and record the raw times, yield and fields present,
  4. run `scrape_html(..., supported_only=False)` and record the parsed fields.

**URLs that returned a recipe page:**

- bbcgoodfood.com/recipes/easy-pancakes
- recipetineats.com/chicken-chasseur/
- cooking.nytimes.com/recipes/1015819-chocolate-chip-cookies
- bonappetit.com/recipe/bas-best-chocolate-chip-cookies
- kingarthurbaking.com/recipes/chocolate-chip-cookies-recipe
- loveandlemons.com/hummus-recipe/
- budgetbytes.com/one-pot-creamy-cajun-chicken-pasta/
- tasteofhome.com/recipes/favorite-chicken-potpie/
- jamieoliver.com/recipes/pasta/classic-tomato-spaghetti/
- cookieandkate.com/best-lentil-soup-recipe/
- smittenkitchen.com/2026/09/tomato-risotto-with-frizzled-red-onions/
- minimalistbaker.com/honey-almond-snack-cake/
- epicurious.com/recipes/food/views/herby-barley-salad-with-butter-basted-mushrooms
- thepioneerwoman.com/food-cooking/recipes/a11442/perfect-pancakes/
- delish.com/cooking/recipe-ideas/a51995/best-loaded-pretzel-bombs-recipe/
- thekitchn.com/how-to-make-banana-bread-236356 (an article page with no `Recipe`)

**Blocked:**

- allrecipes.com/recipe/10813/best-chocolate-chip-cookies/
- seriouseats.com/the-food-lab-best-chocolate-chip-cookie-recipe
- simplyrecipes.com/recipes/homemade_pizza/
- foodnetwork.com/recipes/alton-brown/the-chewy-recipe-1909046 (headless browser worked)

**For each household source, record:**

- supported by a site-specific scraper, or generic?
- fetch status with an honest User-Agent,
- `Recipe` JSON-LD present?
- which stated times are present, and are they ISO 8601?
- which fallback it needs, if any.
