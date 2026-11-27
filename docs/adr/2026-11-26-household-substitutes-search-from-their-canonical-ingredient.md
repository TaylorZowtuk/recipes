# A household substitute's food search starts from its own Canonical Ingredient

Supersedes in part the [substitute FDC food ADR](2026-11-13-editors-pick-a-substitutes-fdc-food.md), which says the PWA's search for a substitute's FDC food offers no Canonical Ingredient's default food, since that belongs to the line's match.

A substitute an editor adds to a line's household substitutions in Our Version names a Canonical Ingredient of its own: "pork shoulder" for a stew's beef line. That Canonical Ingredient's default food is the substitute's, not the line's, so it is the right place to start.

## Decision

- **An added household substitute's search starts from its Canonical Ingredient's default food**, as a line's search starts from its match's. A new Canonical Ingredient has no default food yet, so its search starts from the wording.
- **A substitute kept from the recipe's list searches from its wording, with no default food**, as before, both on the review sheet and in Our Version.

## Consequences

- Adding "pork shoulder" as a substitute offers pork shoulder's usual food straight away, instead of a search the editor types.
- The two ADRs together decide a substitute's search: a substitute the editor adds starts from its Canonical Ingredient, one the recipe gave starts from its wording.
