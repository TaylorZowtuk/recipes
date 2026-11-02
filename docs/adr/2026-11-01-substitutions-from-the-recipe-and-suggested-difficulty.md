# Substitutions come only from the recipe, and enrichment suggests a Difficulty

The [enrichment pipeline ADR](2026-09-26-enrichment-pipeline.md) says the LLM "proposes substitutions" with no source. This supersedes that part: enrichment records only the substitutes **the recipe itself states**. It never invents its own. It also settles how enrichment's suggested **Difficulty** is stored and shown. Everything else in the enrichment pipeline ADR stands.

We chose this because a model that proposes substitutes from its own cooking knowledge produces swaps that look plausible and that nobody would catch, which is the failure the enrichment pipeline ADR set out to avoid for numbers. A substitute the recipe states ("butter or margarine") is the author's claim, and the household's own swaps have a place of their own.

## Substitutions

- **Source:** a substitute counts only if the recipe states it, in an ingredient line ("butter or margarine"), in a step, or in the description. Substitutions the household adds belong to Our Version ([#71](https://github.com/TaylorZowtuk/recipes/issues/71)) and are stored with provenance `editor`.
- **Pass 1, `enrich substitutes`:** the model quotes, verbatim, each substitute the recipe states for a line, and says where it quoted it from (a line, a step or the description).
- **Pass 2, `enrich packet --substitutes <file>`:** code checks that every quote appears verbatim in the place named, then offers Canonical Ingredient and FDC candidates for each wording. Those offers are part of the recipe's `offer_id`, so a changed offer invalidates an answer made against the old one.
- **The answer:** for each substitute, a candidate Canonical Ingredient (never a new one), the FDC food and portion, an estimated ratio (above 0 and at most 10) and a note. `enrich apply --substitutes <file>` rejects any pick that wasn't offered.
- **Stored** as `iN.substitutions`: one fact per line, holding its list of substitutes, with provenance `llm`, estimated and unconfirmed. The FDC numbers are copied in for each substitute, as the [recipe data model ADR](2026-09-29-recipe-data-model.md) says.
- **Hidden until confirmed:** unconfirmed substitutions are never shown as swaps, and [fridge matching](2026-10-01-fridge-matching.md) reads Confirmed ones only.
- **Optional lines:** the model may also correct the parser's `optional` flag ("optional", "for garnish", "to serve") on a line, like any other text-derived field.

## Suggested Difficulty

- Enrichment writes its suggestion as the per-recipe fact `difficulty`, with provenance `llm`, estimated and unconfirmed. The editor field **Difficulty** is separate and always wins.
- When the editor hasn't set a Difficulty, the card and the recipe view show the suggestion, labelled as a suggestion, and the card's Difficulty filters use it.
- Confirming the suggestion in the review flow ([#58](https://github.com/TaylorZowtuk/recipes/issues/58)) makes it the recipe's Difficulty.

## Consequences

- Fewer substitutions than a model would invent: a recipe that states none has none until the household adds one.
- Enrichment of substitutions takes two passes and a file between them. The cost is one extra model call per recipe that states a substitute.
- A card can show a Difficulty the editor never set. Its label says so, and the editor's own value replaces it.

## Considered options

- **The model proposes any same-family Canonical Ingredient:** rejected, because families are too broad to treat as interchangeable (feta and parmesan are both *cheese*), as the fridge matching ADR says.
- **Offer the whole Canonical Ingredient list:** rejected, because the packet would grow with the collection and the model would pick from too many options.
- **Code detects alternatives only in the line text:** rejected, because it misses those stated in steps and the description.
- **Write the suggested Difficulty into the editor field with a flag:** rejected, because the editor's rating and the model's guess would share one value, and a later enrichment or an edit could overwrite the wrong one.
