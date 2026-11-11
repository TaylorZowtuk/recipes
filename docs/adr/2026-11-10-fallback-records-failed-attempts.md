# The fallback records why its latest try at a waiting Queued Ingest failed

When a fetch in `python -m recipes.fallback run` fails with reason `rate_limited`, `server_error` or `unreachable`, `run` records that reason on the Queued Ingest through `POST /api/queued-ingests/{ingest_id}/failed-attempt {reason}`. The Queued Ingest stays `waiting`. This replaces "writes nothing" in the [ingest fallback chain ADR](2026-11-05-ingest-fallback-chain.md). Everything else there stands.

## Why

A Queued Ingest's reason was why Add a recipe's plain fetch stopped, and the fallback never changed it while it waited. So "Waiting to be added" could say a site couldn't be reached when every `run` since had got a 429 or a 503 from it. An editor deciding whether to paste the page, discard it or wait for the next run needs the latest reason.

## The endpoint

- It takes only `rate_limited`, `server_error` or `unreachable`. Any other reason is a 422: a reason that won't pass goes through `needs-page`.
- On a waiting Queued Ingest it sets the reason and leaves the state `waiting`. One that needs its page stays as it is, so a fallback can't overwrite the reason an editor is shown for pasting. A Queued Ingest that has gone is a 404.
- Only an editor can call it, and the service token counts as one, as for `needs-page`.
- A Queued Ingest isn't shared data, so `META#collection` stays as it is.

## Consequences

- `run` writes for every waiting Queued Ingest it tries, so a `run` over a queue that is all unreachable now makes one write per Queued Ingest rather than none.
- A refused `failed-attempt` call is that Source's failure alone: `run` counts it as failed, not still waiting, so it makes the exit code non-zero, and the others go on.
- Only the latest reason is kept. No attempt time or count is stored, and there is still no retry limit or back-off: a temporary failure stays waiting however long it lasts, as the fallback chain ADR accepts.
