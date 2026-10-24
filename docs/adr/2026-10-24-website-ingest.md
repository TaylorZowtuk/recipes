# A website is ingested in two stateless steps, and a failed plain fetch becomes a Queued Ingest for the local CLI

The API Lambda does one thing with a website: a polite plain fetch, parsed by `recipe-scrapers`. Playwright, LLM extraction and any other fallback run in the local CLI ([TaylorZowtuk/recipes#50](https://github.com/TaylorZowtuk/recipes/issues/50)), so the backend has no headless browser and makes no LLM call. This extends the [recipe data model ADR](2026-09-29-recipe-data-model.md) with one more kind of item and a wider source guard. It departs from nothing the [enrichment ADR](2026-09-26-enrichment-pipeline.md) says: ingest still stores only the Original, and enrichment runs after the recipe is saved.

## The flow: preview, then save

1. `POST /api/ingest {url}` normalises the URL, checks the source guard, and only then fetches and parses. On success it returns the captured Original and the website Source. **Nothing is stored.**
2. The editor reviews the Original beside optional Difficulty and Tags. `POST /api/recipes {source, original, difficulty?, tags[]}` saves it: **the client sends the captured Original back.**
3. Save writes the recipe (Enrichment Status *Pending*, `ingest_channel` set to Add a recipe), its card, its source guard and the `META#collection` bump in one transaction. A guard that already exists at save is a 409 duplicate.

We chose a client that returns the Original over keeping a draft on the server, because there is then no draft state to expire, clean up or show in the Collection. The editors are trusted, and the CLI already writes Originals through the API with the service token, so the save endpoint accepts a ready-made Original anyway. The Original is whatever an editor reviewed, not something the server must be able to reproduce. Raw HTML and JSON-LD are never stored, and never sent to the client: the response carries only the parsed Original.

## Fetch policy

- **User agent:** an honest `Plateful/1 (+https://github.com/TaylorZowtuk/recipes)`. The [research note](https://github.com/TaylorZowtuk/recipes/blob/research/recipe-scraping/docs/research/recipe-scraping.md) found sites that block a spoofed browser agent and allow an honest one.
- **robots.txt:** read with `protego` (RFC 9309). A 4xx on `robots.txt` means allowed. A 5xx or an unreachable `robots.txt` means disallowed for now, which is a transient failure, not a refusal (see below).
- **Timeout and retries:** about 8 s per request, so robots.txt plus the page fit the 30 s CloudFront and Lambda limit. No retries: one editor-initiated request per recipe.
- **Body size and the deadline:** bodies are streamed, and a 14 s deadline for the whole fetch is checked before each request, as each piece of a body arrives, and caps each request's timeout. A timeout is per read, so a site sending a byte a second would never trip it: at the deadline a watchdog shuts the socket the fetch is waiting on, and the fetch ends unreachable a few milliseconds after 14 s. A DNS lookup can't be woken this way and is left to the resolver's own timeout. The parse follows, which on a 5 MB page dense with tags took about 8 s on a development machine, so the worst case is about 22 s, leaving the queue write room inside the 30 s. A page may decode to at most 5 MB and a robots.txt to at most 512 KB, decompression included. Past either limit the Source waits as unreachable.
- **Parse:** `recipe_scrapers.scrape_html(html, org_url=<final URL>, supported_only=False)`, recording `extractor = "recipe-scrapers"`. The final URL, after redirects, picks the site's scraper, while the pasted URL stays the Source and its dedupe key. Any error from a scraper, or a recipe past an Original's size limits, is the no-recipe outcome.
- **Redirects:** followed by hand, at most 5, each hop only if its own host's robots.txt allows it (each robots.txt read once per ingest). A robots.txt's own redirects are followed by hand too, at most 5, so each hop gets its own timeout inside the deadline. A refusal at any hop is the robots outcome. Too many redirects, or the whole fetch running past its 14 s deadline, waits as unreachable.
- **Public addresses only:** before each hop's robots check, and before each hop of a robots.txt's own redirects, the host requests will connect to (its IDNA 2008 form) is resolved, and if any of its addresses is loopback, private, link-local or otherwise not global, nothing is requested and the Source needs its page (reason blocked). A pasted URL or a site's redirect can't reach the machine the API runs on or its network. DNS rebinding is an accepted residual: a host's address can change between this check and the HTTP client's own lookup. Pinning the connection to the checked address needs a custom transport adapter, which isn't worth it when only signed-in editors can start a fetch and its worst case is a blind GET: the response is only parsed for a recipe, never shown as it came.
- **Order:** the duplicate check comes first, before robots.txt or the page is requested.

## Queued Ingest

When the plain fetch can't produce a recipe, the Source is reserved rather than the attempt lost. A **Queued Ingest** is an item in one partition (`INGEST`, sort key its ULID, like the cards' `CARD` partition, so listing them in queue order is one query) holding `{schema_version, id, source, dedupe_key, state, reason, queued_at}`, written in one transaction with its source guard. It has a `state`:

- `waiting`: the local CLI fallback chain ([TaylorZowtuk/recipes#50](https://github.com/TaylorZowtuk/recipes/issues/50)) will try it.
- `needs_page`: an editor has to paste the page or its text. The completion UI belongs to [TaylorZowtuk/recipes#50](https://github.com/TaylorZowtuk/recipes/issues/50).

Which failure leads where:

| Outcome | Result |
| --- | --- |
| Invalid or non-http(s) URL | 422, nothing stored |
| Guard exists (recipe or Queued Ingest) | 409 naming what it points at, nothing fetched |
| 404 or 410 | Final error "page not found", nothing stored |
| robots.txt disallows | Queued Ingest in `needs_page`, reason robots. No automated fetch is tried later |
| The URL or a redirect leads to an address that isn't on the public internet | Queued Ingest in `needs_page`, reason blocked. No automated fetch is tried later |
| 403 or any other 4xx, 429, 5xx, timeout, connection error, unreachable or 5xx `robots.txt`, or a page with no recipe found | Queued Ingest in `waiting` |

Queued Ingests are **not cards and not in the Collection bundle**, so phones never download or cache them. Add a recipe lists them ("Waiting for the fallback") from an editor-only `GET /api/queued-ingests`, which the CLI also reads with the service token. Despite the name, a Queued Ingest has nothing to do with Enrichment Status *Pending*: that is a saved recipe waiting for enrichment, while a Queued Ingest is a Source with no recipe yet.

## The source guard now has two targets

`SOURCE#<dedupe_key>` points at either a recipe or a Queued Ingest. The data model ADR says the guard is written in the same transaction as the recipe. That still holds: it is now also written in the transaction that creates a Queued Ingest. How a Queued Ingest becomes a recipe is [TaylorZowtuk/recipes#50](https://github.com/TaylorZowtuk/recipes/issues/50)'s to decide.

## Normalisation

The website `dedupe_key` extends the data model ADR's summary with the exact rules:

- scheme forced to https, host lower-cased, a leading `www.` stripped, default port dropped, fragment dropped, trailing slash dropped;
- tracking parameters removed: `utm_*`, `fbclid`, `gclid`, `dclid`, `msclkid`, `mc_cid`, `mc_eid`, `_ga` and `igshid`. Any other parameter, `ref` included, is kept, because some sites select the recipe with one;
- remaining parameters sorted by name;
- path case kept, since paths are case-sensitive.

A URL whose host IDNA can't encode, or whose key would pass 2000 bytes (under DynamoDB's 2048-byte key, with room for `SOURCE#`), is invalid.

## Stated Times

A Stated Time's `text` is the site's string exactly (`PT1H15M`, `1 hour`), read from the raw schema.org data (`scraper.schema.data`: `prepTime`, `cookTime`, `totalTime`), not from the integer minutes `recipe-scrapers` returns. Those minutes lose information, as the research note shows. `seconds` is parsed at ingest only when `text` is an ISO 8601 duration of whole days, hours, minutes and seconds, and is otherwise null, left for enrichment. The UI humanises an ISO duration ("1 hr 15 min") and shows other text as written. Any of the three may be absent.

## Considered options

- **Re-fetch the page on save:** rejected. It doubles the requests to the site, and the saved Original could differ from the one the editor reviewed.
- **A draft stashed on the server between preview and save:** rejected. It adds state with a lifetime to expire and clean up, for no benefit with trusted editors.
- **A placeholder card in the grid for a failed ingest:** rejected. It would put an incomplete recipe into the Collection bundle and every phone's cache, and every reader of cards would have to handle it.
- **Treating a robots.txt refusal as final:** rejected. The editor can still supply the page themselves, and the household may paste a page they could open in their own browser. Only an automated fetch is ruled out.
- **Treating a 404 as a Queued Ingest:** rejected. No fallback will find a page that isn't there.
- **Adding the `video` and `print` Source variants now:** deferred. The data model ADR adds them later without a migration.
