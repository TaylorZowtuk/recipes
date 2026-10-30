# Wording Cache learns unconfirmed mappings

The [enrichment pipeline ADR](2026-09-26-enrichment-pipeline.md) says that "a wording seen before maps without the LLM". This supersedes that part. Enrichment learns every wording a validated answer maps, but **unconfirmed**, and an unconfirmed wording is only a hint: the model still chooses. Only a wording an editor confirmed fixes its **Canonical Ingredient**. Everything else in the enrichment pipeline ADR stands.

We chose this because nothing checks what the cache learns until an editor reviews it. If the first answer for a wording were final, one wrong match ("cream" → *ice cream*) would be copied into every later recipe without the model or an editor looking at it again.

## How the Wording Cache is used

- **Learning:** every answer that passes the Work Packet's checks writes its wordings (each parsed line's normalized name → the Canonical Ingredient it chose) with `confirmed=false`. A line without a parse learns nothing.
- **An unconfirmed hit:** the cached Canonical Ingredient is offered first, marked `from_wording`, among the other candidates. The model checks it and may choose another, or a new Canonical Ingredient.
- **Replacing:** a later answer that maps the same wording elsewhere replaces an unconfirmed wording.
- **A confirmed hit:** the confirmed Canonical Ingredient is the only candidate offered, the model can't create a new one for that wording, and no answer replaces it. The store refuses to overwrite a confirmed wording.
- **Confirming:** an editor confirms a wording when reviewing the enrichment, which is [#58](https://github.com/TaylorZowtuk/recipes/issues/58).

## Consequences

- Until editors confirm wordings, every line still goes through the model, so the cache saves no model work yet. It only puts the earlier choice in front of the model.
- Two answers can disagree about an unconfirmed wording, and the later one wins. Each recipe keeps the match it was enriched with.

## Considered options

- **The first answer fixes the wording, as the enrichment pipeline ADR said:** rejected, because an unreviewed mistake would spread to every later recipe with that wording.
- **Learn nothing until an editor confirms:** rejected, because the model would lose the earlier choice as a hint, and an editor would have nothing to confirm from.
