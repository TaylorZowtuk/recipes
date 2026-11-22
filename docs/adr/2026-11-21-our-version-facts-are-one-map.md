# Our Version's facts are one map, addressed `our_version.<id>.<fact>`

Supersedes in part the [recipe data model ADR](2026-09-29-recipe-data-model.md), whose overlay example puts an edited line's `parse` and `match` inside its `edit` entry. The overlay's facts live in one map instead.

## Decision

- `our_version.facts` is a `RecipeFacts`, the same model as `recipe.facts`, keyed by line and step id. An edited or added line's parse, match and conversion are at `our_version.facts.ingredients["i4"]`.
- The overlay's `ingredients.edit` entries keep only what isn't a fact: `text` and `component`. An `add` entry keeps `id`, `after`, `component` and `text`. Steps are the same, text and component only.
- A fact in the overlay is addressed as one in the Original is, with `our_version.` in front: `our_version.i4.parse`, `our_version.s3.segments`. An Enrichment Issue on an Our Version line names its fact that way.
- A line or step Our Version leaves alone has no entry in the map, and keeps the Original's facts.
- A wording an editor fixes reaches the Our Version lines with it, in this recipe and in others, as it reaches the Original's lines. A line the editor picked on keeps their pick.

```json
"our_version": {
  "ingredients": {
    "edit":   {"i4": {"text": "½ tsp salt", "component": null}},
    "remove": ["i9"],
    "add":    [{"id": "i11", "after": "i3", "component": "For the marinade", "text": "2 cloves garlic"}]
  },
  "steps": {"edit": {"s3": {"text": "…", "component": null}}, "remove": [], "add": []},
  "facts": {"ingredients": {"i4": {"parse": {…}, "match": {…}}, "i11": {…}}, "steps": {}},
  "note": "Less salt, more garlic.",
  "edited_at": "2026-10-02T18:30:00Z"
}
```

## Why

- **Substitutions on a line Our Version doesn't otherwise change** (TaylorZowtuk/recipes#170) need a home that isn't an edit of the line. With facts inside `edit`, a substitution would need a copied parse and text, and the line would show as changed.
- **Step Segments** (TaylorZowtuk/recipes#169) go at `our_version.sN.segments`, beside the line facts, with nothing new to look them up.
- **The code that works on facts by path works on the overlay as it is**: `fact_at`, the wording spread (`SharedMatch`) and `confirm_matches` take a `RecipeFacts`. With facts inside each line, every one of them would need a second resolver that searches `edit` (a map) and `add` (a list).
- Nothing is stored in production yet, so the shape changes with no migration.

## Considered options

- **Facts inside each `edit` and `add` entry, as the data model ADR's example has them:** rejected, because #170 and #169 would each add a second home for overlay facts, and the fact-path code couldn't see them.
- **Inline facts, plus a substitutions map for unchanged lines:** rejected as two homes for one kind of thing.
