# Favorite Sites match on a card's host, and a missing item is created at start-up

A Favorite Site shows how many recipes in the Collection came from it, and the Favorite Sites are a new item that existing stacks don't have. This supersedes one point of the [recipe data model ADR](2026-09-29-recipe-data-model.md): it rejected additive changes with no schema version, and these two are made without one. Every other schema change still goes through a migration.

We chose this because a bump is out of proportion here. The API refuses to start when `META#schema` doesn't match, so a bump needs the read-only window and a `migrate` run, for one optional field and one item that starts empty.

## The card holds the host, with no backfill

A card gains an optional `host`, derived by `card_for` from the recipe's `dedupe_key`, and null for any other Source. A card stored without one loads with null and counts for no site until its recipe is next written. Counts start low on an existing stack and correct themselves as recipes change. We accepted that over a backfill, which is the migration this avoids.

We rejected matching on `site_name`, because a page names itself and two pages on one site can give two names. We rejected reading recipes to count them, because the bundle is built from cards.

## Matching is exact host equality

A Favorite Site's host is the host of its address's dedupe key, normalised as a recipe's is: lowercased and without `www.`, keeping any non-default port. A path in the address is ignored for matching, though the address is kept as written. A site matches the cards with exactly that host.

- `blog.example.com` and `example.com` are different hosts. Subdomain matching would make one recipe count for two sites.
- Two sites on one host are refused with a 422, so no recipe counts twice.
- The count is worked out in `get_collection` and the Edit's response, and never stored, so a write to a recipe needs nothing beyond the bump it already makes.

## A missing item is created at start-up

`bootstrap` used to write items only when `META#schema` was missing, so an existing stack would never get the Favorite Sites, and every bundle read would fail. Once the schema version checks out, it now reads the item and, if it is missing, creates it empty and bumps `META#collection` in one transaction. The bump moves phones and CloudFront off the cached bundle that lacks the field.

- The create is conditional on the item not existing, so of two cold starts racing, one writes and bumps and the other changes nothing.
- A start that runs out of retries fails rather than serve without the item. Lambda starts it again on the next request.
- A stack that already has the item pays one extra consistent read on each cold start, and writes nothing.
- A bundle built by older code can stay cached at the current version if the old API serves it after the bump. `make smoke` fails on a bundle without the field, and any Collection write heals it by moving to a new version.

A new stack gets the empty item in the transaction that creates it.

## A field added to a stored card takes a default

A card is read back through its model, so a required field added later fails every bundle rebuild on the cards stored before it. A cached bundle hides that until the counter moves: `NeedsReview.flagged` passed staging's deploy, then every bundle read there was a 500 once the counter moved. A new field on a stored card therefore takes a default, and the card gains the real value on its next write.
