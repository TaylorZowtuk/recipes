# Phones cache the collection behind a version counter, queue only conflict-free writes offline, and poll a tiny sync endpoint

The PWA keeps the whole collection on installed phones and finds out about changes by polling one small uncached endpoint, `GET /api/sync`. Offline, it queues only the writes that can't conflict (grocery ticks and Extras) and turns every other edit off. We chose polling because it fits the $0 stack: WebSockets would need API Gateway, whose free allowance has expired for this account, and Web Push needs an installed app, notification permission and a store of push subscriptions. We chose to queue only conflict-free writes because ticking groceries in a store with no signal is the one offline edit that matters, and a queue that can't conflict never needs a "your offline change was rejected" screen.

## Noticing changes

- A **`META#collection`** item holds a counter. Every write to shared collection data (cards, recipes, Canonical Ingredients, the wording cache, Kitchen settings, Favorite Sites) bumps it atomically, in the same transaction as the write. Week Plans don't bump it.
- **`GET /api/sync`** is never cached. It returns `{collection_version, schema_version, read_only, weeks: {<monday>: version}}`. `read_only` is `"updating"` during a migration window and otherwise null. `weeks` is present only for an editor, and only for the weeks the phone asks to watch. A poll costs one Lambda call and about 1.5 RCU.
- When the counter has moved, the phone fetches **`/api/collection?v=<n>`**: the cards, Canonical Ingredients, wording cache (the Fridge typeahead searches it), Kitchen settings and Favorite Sites in one response. CloudFront caches it for good under that `v`, just as it caches recipes under their version.
- Each card carries **`recipe_version`**. The phone compares it and `schema_version` with what it holds and refetches only the recipe items that changed.

## What's cached, and for whom

- **Installed, or an editor is signed in:** everything is prefetched: the collection bundle, every recipe item and every card-size image. The phone asks for `navigator.storage.persist()`. Full-size images are cached when a recipe is opened, capped at about 200 MB with least-recently-used eviction. Candidate photos the editor didn't pick are never cached.
- **A visitor in a browser tab:** only what they open. Safari clears script storage for sites that aren't installed after 7 days, so a full prefetch would mostly be wasted data and CloudFront transfer. A recipe that isn't cached shows "Not available offline" in its place.
- **Week Plans (editors only):** the current and next weeks are always cached and watched. Any other week is cached once it's viewed but isn't watched. A visitor's Demo is never cached or synced.
- Ingest writes a **card-size copy** (about 400 px wide) of each image next to the full one, so the grid and the prefetch never download full-size photos. Offline, a recipe whose full image isn't cached shows its card-size preview.

## Sync between phones

- The phone polls `/api/sync` when the app regains focus, **every 3 s while the Week or Grocery List tab is visible**, every 60 s elsewhere, and never while the page is hidden. Visitors poll only at 60 s, because the Demo isn't synced.
- After about 5 minutes without a touch or scroll the 3 s poll drops to 60 s, and any interaction brings it back. Without this, a desktop tab left open on the Week tab would spend most of Lambda's free 1M requests a month on its own.
- Two phones on the home Wi-Fi share one IP and make about 200 polls per 5 minutes between them, so the WAF rate-limit rule is set at about **1,000 requests per 5 minutes per IP**. The two numbers must move together.
- A watched Week Plan is refetched only when its version moves.

## Offline writes

- **Queued:** grocery ticks (already atomic set adds and removes) and **Extras**, which become a map keyed by Extra id with atomic add and remove, so they no longer depend on the plan's version (amended in the [grocery list ADR](2026-09-29-grocery-list-aggregation.md)). A queued change shows as applied at once, with an "N changes waiting to sync" marker. When it replays, the server's state is the truth and changes still pending are drawn on top of it.
- **Off while offline:** every other edit (Week Plan entries and amounts, tags, Difficulty, Our Version, review, Kitchen settings, Favorite Sites) is greyed out. These are written conditionally on a version, and a replayed 409 would need a merge screen.
- **The queue's operations are kept stable across schema versions**, so a queue built during an Updating window still replays against the new API.
- **Failures:** a 401 keeps the queue and asks the editor to sign in, then replays. Any other permanent 4xx (for example a Week Plan restored from a snapshot) drops the operation and shows "1 offline change couldn't be saved".
- **Sign-out** deletes the cached Week Plans and the queue. If the queue isn't empty it asks first: "3 changes haven't synced. Sign out anyway?"

## Read-only modes

Editors see one slim banner, and all three modes behave like offline: ticks and Extras queue, everything else is greyed out. Visitors see no banner, because they have nothing to edit.

- **Offline:** "Offline — ticks will sync later."
- **Updating** (`read_only: "updating"`): "Updating — editing is back in a few minutes."
- **API unreachable while the network is up:** "Editing is paused." This is how the kill switch looks: with Lambda throttled, `/api/sync` itself fails, so the phone can't tell it from an outage and doesn't try.

## App updates

- When `/api/sync` reports a `schema_version` other than the one the bundle was built for, the phone replays its queue if it can, updates the service worker and reloads. Then it throws away its cached data and fills the cache again. Nothing is migrated on the phone, so the code only ever handles one shape, as in the [data model ADR](2026-09-29-recipe-data-model.md).
- Updates that don't change the schema install silently and take effect on the next launch, never in the middle of cooking mode.

## Considered options

- **Refusing every edit offline:** simplest, but it gives up ticking groceries in a store with no signal.
- **Queueing every operation:** replays of versioned writes can come back as a 409, which needs a screen for rejected offline changes across Week Plans, tags, Our Version and review.
- **A short CloudFront TTL on the collection, or invalidating it on every write:** a short TTL refetches the whole bundle on a timer, and invalidations past the free allowance are billable. The counter costs about 1 RCU a poll and reuses the versioned-URL pattern recipes already have.
- **Web Push or WebSockets for sync:** see above. Shopping together is the only time seconds matter, and a 3 s poll covers it.
- **Caching the whole Week Plan history:** past weeks hardly change and are mostly looked at online.
