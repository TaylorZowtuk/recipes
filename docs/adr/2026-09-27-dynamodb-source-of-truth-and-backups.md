# DynamoDB is the source of truth, the API is its only writer, and nightly snapshots are the backup

Recipe and household data live in **DynamoDB**, one table per stack. Images live in S3. Neither ever goes in the public repo. We chose DynamoDB over files in S3 (one JSON object per recipe, which kept the data next to the images) because DynamoDB is Always Free with conditional and atomic writes built in, and in provisioned mode it throttles instead of billing. The costs are that reads are charged by whole-item size under a small capacity budget, and that backups need our own export and restore code. The layout and the restore path below are shaped around both.

## Table layout

One table per stack, with **no secondary indexes**, because an index would need its own share of the 25 RCU/WCU that prod and staging split ([stacks ADR](2026-09-26-prod-and-staging-stacks.md)).

- **Card items:** one small item per recipe (title, source site, stated total time, Difficulty, tags, Enrichment Status, image), all in a single collection partition. The Recipes grid is one Query of about 60 RCU. A Scan of full recipes would cost about 2,000 RCU.
- **Recipe items:** the full recipe (Original, Our Version, enrichment) sits in its own partition and is read when the recipe is opened. The API serves it with the recipe's version in the cache key, so CloudFront answers repeat reads and the offline cache fill without touching DynamoDB.
- **Household items:** one item per **Week Plan** (keyed by its Monday, with its entries, scales, logging and grocery ticks), one for **Favorite Sites** and one for Kitchen settings (**Store Categories** and **Pantry Staples**).
- A change that alters both a card and its recipe is written in one transaction.

The exact attributes are set by the recipe data model.

## Writes

- **The API is the only writer.** The app on the phones, the local `enrich` CLI, the bulk import and `backup pull` all sign in as an editor and call the API. Nothing local ever holds prod AWS credentials, so validation and card upkeep happen in one place, and the kill switch really does make the whole app read-only. Editor sign-in must therefore support a non-browser client.
- **The API takes operations, not documents,** for example "tick item X", "add this recipe to Wednesday" or "set tags". Two editors seldom touch the same thing.
- **Grocery ticks** are atomic add and remove operations on a set, so two phones ticking at the same moment never conflict.
- **Every other item carries a version** and is written only if the version hasn't changed. On a conflict the API returns 409, and the app reloads and shows the newer state. Nothing is merged silently.

## What stays on the device

Cooking progress (ticked steps and where to resume), the Adjust sheet's version, scale and unit choices, per-ingredient unit cycling, unsaved Edit drafts and the offline cache never reach the server. Everything the household shares is stored in the table.

## Backup

- **Snapshot:** a scheduled Lambda runs a paced Scan of prod each night and before every release (about 2,000 RCU, a few minutes). It writes the items as **one gzipped JSON Lines file** (one item per line) to a separate backup bucket.
- **Images** never change once stored and have content-hashed keys, so each run copies only the new ones into the backup bucket.
- **Retention:** 30 nightly and 12 monthly snapshots, a few MB each, well inside the 5 GB S3 credit.
- **Off-AWS copy:** once a month an editor runs `backup pull`. It asks the API for short-lived download links and saves the latest snapshot and any missing images to a folder the household controls. The app can then be rebuilt even without this AWS account.
- **Undoing a bad edit:** a CLI command restores one recipe or one Week Plan from a chosen snapshot, so at most a day's edits are lost. The Original never changes, so what's at risk is tags, Difficulty, Our Version and household state.

## Restore and the drill

Restoring can't run in a Lambda: at staging's 5 WCU, loading about 15 MB takes roughly 50 minutes, and Lambda stops after 15. It is a **local or CI CLI** that runs with staging's role. It empties staging's table, loads a prod snapshot at a steady pace and copies the images into staging's bucket. Staging's role may read prod's backup bucket but never write it. The capacity split stays at prod 10/10 and staging 5/5.

Refreshing staging from prod's backup before a release is the backup/restore drill. It passes when the Playwright end-to-end checks run green against the restored staging.

## Considered options

- **S3 files as the source of truth,** with the API keeping an index object up to date: this kept the data next to the images and made a backup a simple copy of objects. It was rejected in favor of DynamoDB's conditional and atomic writes, and so that we don't have to keep an index in step by hand.
- **S3 files as the truth with DynamoDB as a rebuildable index:** two stores to keep in step, for queries we don't need at around 500 recipes.
- **A prod write role for the local CLI:** rejected, because it breaks the rule that nothing local holds prod credentials.
- **DynamoDB point-in-time recovery:** rejected. It restores only into a new table, it's another billed service, and nightly snapshots bound the loss to a day.
- **Keeping previous versions of each item in the table:** rejected, because it spends write capacity on every edit.
- **Restore in a Lambda,** or raising staging's capacity for a restore: rejected. A paced CLI has no time limit and leaves the capacity split alone.
