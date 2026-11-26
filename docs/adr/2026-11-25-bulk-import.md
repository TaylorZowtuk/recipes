# Only the service token saves a recipe as the bulk import, which queues what it can't read for the fallback

The bulk import is a local CLI, `python -m recipes.bulk_import <API base URL> <sources file, or - for stdin>` (`make bulk-import ARGS='<base URL> -' < sources.csv` from the host). It reads a CSV sources file with the header `kind,location,notes` and ingests each `website` row through the API with the service token. Any other kind is skipped, and `notes` is ignored. This settles what the [enrichment pipeline ADR](2026-09-26-enrichment-pipeline.md) and the [ingest fallback chain ADR](2026-11-05-ingest-fallback-chain.md) left open about the bulk import. Everything else in them stands.

## Who may set the Ingest Channel

`POST /api/recipes` takes an optional `ingest_channel`, `add_a_recipe` when it's left out, and saves it on the recipe. Only the service token may send `bulk_import`: a signed-in editor who sends it gets a 403. The PWA never sends the field. A bulk import skips Awaiting Review, so a recipe an editor adds in the app can't claim it.

`POST /api/queued-ingests/{ingest_id}/recipe` keeps the fallback chain ADR's rule that its recipe is always Add a recipe's. This ADR adds the enforcement: a body with `bulk_import` is a 422.

## What the bulk import does with each Source

1. `POST /api/ingest`. A 409 (the Source Guard: already a recipe or already queued) is **skipped**, so a re-run is safe.
2. A 202 leaves a Queued Ingest. The bulk import counts it as **queued** and moves on. It doesn't run the browser, recipe-scrapers or a model itself: the fallback (`make fallback`, or the enrich-pending skill) finishes it later, as Add a recipe, so it stops at Awaiting Review. The summary says to run the fallback whenever anything was queued.
3. A 200 is saved the way Add a recipe and the fallback save one: each Candidate Photo through `POST /api/images` (one that fails is dropped), the first stored one as the Preview Photo with its Focal Point centred, then `POST /api/recipes` with `ingest_channel: bulk_import`. A 201 is **ingested**, a 409 skipped.
4. Anything else, a 404 or a network error included, is **failed** with its reason, and the next Source goes on. The CLI exits 1 when any Source failed.

## Why the sources file comes on stdin

The household's sources file holds the private list of sites, so it lives outside the repo and its worktrees. The toolchain container mounts only the repo, so `make bulk-import` reads the file from stdin, which the host shell redirects.

## Considered options

- **Running the fallback chain inside the bulk import:** rejected. The fallback already finishes every waiting Queued Ingest in the household's own session (the browser, then a model's Work Packet), and a recipe saved from a Queued Ingest is Add a recipe's by that endpoint's rule. The consequence: a Source on the list that a plain fetch can't read waits at Awaiting Review, even when the browser captured it.
- **Letting any editor send `bulk_import`:** rejected. Only the CLI imports in bulk, and a recipe an editor reviews by hand has no reason to skip review.
