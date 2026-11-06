# Deleting a Store Category moves its ingredients in chunks and removes the category last

Deleting a Store Category moves its Canonical Ingredients to another one. A category such as Aisles can hold more ingredients than fit a DynamoDB transaction, which holds 100 items, so a delete can't always be one atomic write. This supersedes one point of the [DynamoDB ADR](2026-09-27-dynamodb-source-of-truth-and-backups.md): that every versioned item is written only if its version hasn't changed. A move is conditional on the ingredient's Store Category instead. Everything else in that ADR stands.

## How a batch writes

An Edit of the Store Categories resolves its deletes first, so if one delete moves A to B and a later one moves B to C, A's ingredients go straight to C.

A delete's target must already be saved, because the API mints a new category's id, so a client can't name it in the batch that adds it.

- **Up to 98 moves:** one transaction holds the moves, the Kitchen settings and the `META#collection` bump.
- **More than that:** the moves go first, in chunks of 98. Each chunk also holds a condition check on the Kitchen settings version, so a stale editor stops early, and a `META#collection` bump. The ingredients are read again after the chunks, and any that arrived meanwhile are moved in the last transaction, which writes the Kitchen settings.

## A move is conditional on the category, not the version

Each move updates only `store_category_id` and `version`, on the condition that `store_category_id` is still what was read. A Pantry Staple change that lands between the read and the move survives and doesn't cost the editor a conflict. The move still bumps the version, so a write that read the ingredient before the move fails its own version check rather than putting the old category back.

An ingredient whose category changed under the move fails that condition, and the Edit answers 409.

## Choosing an ingredient's Store Category

Setting one Canonical Ingredient's Store Category carries a condition check on the Kitchen settings version, so it can't land in a category a saved Edit just deleted. A Pantry Staple change doesn't depend on the Kitchen settings, so it carries no such check. It still answers 409 if a move landed after the client read the ingredient, because the move bumped the version.

## Consequences

- A delete past the limit isn't atomic. A conflict or a crash part way leaves some ingredients moved, with the category they left still in place, so nothing is orphaned. The phones see that state, because each chunk bumps `META#collection`.
- After a 409 the app discards the Draft, so some ingredients have moved, the category is still there and the rest of the Draft is gone. The editor reopens Edit and repeats the delete, which re-reads the ingredients and moves the rest.
- Only a 5xx or a network failure keeps the Draft. The Kitchen settings version is still current then, so Save can retry directly.
- An ingredient given the category in the moment between the last read and the Kitchen settings write is left with a Store Category that's gone. The condition check doesn't catch this, because the Kitchen settings version moves only with that final write. Enrichment creating a Canonical Ingredient has the same gap, with no check at all. The Edit reads the ingredients as late as it can, and with one or two editors the gap is small enough to accept.

## Considered options

- **Write the Kitchen settings first and the moves after:** a crash would leave ingredients in a category that no longer exists, with no way to finish the job.
- **Mark the category as being deleted, then move, then remove it:** closes the gap above, but adds a state that every reader of the Kitchen settings has to understand, for a race between two editors.
- **Move with the ingredient's version as the condition:** a Pantry Staple change during a long delete would fail the delete for an unrelated reason.
