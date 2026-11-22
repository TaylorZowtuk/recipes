# Our Version's facts are one map, addressed `our_version.<id>.<fact>`

Supersedes in part the [recipe data model ADR](2026-09-29-recipe-data-model.md), whose overlay example puts an edited line's `parse` and `match` inside its `edit` entry. The overlay's facts live in one map instead.

## Decision

- `our_version.facts` is a `RecipeFacts`, the same model as `recipe.facts`, keyed by line and step id. An edited or added line's parse, match and conversion are at `our_version.facts.ingredients["i4"]`.
- The overlay's `ingredients.edit` entries keep only what isn't a fact: `text` and `component`. An `add` entry keeps `id`, `after`, `component` and `text`. Steps are the same, text and component only.
- A fact in the overlay is addressed as one in the Original is, with `our_version.` in front: `our_version.i4.parse`, `our_version.s3.segments`. An Enrichment Issue on an Our Version line names its fact that way.
- The map holds the facts Our Version adds or replaces: today an edited or added line's parse, match and conversion; later an unchanged line's substitutions (TaylorZowtuk/recipes#170) and a step's Segments (TaylorZowtuk/recipes#169). Any fact the map doesn't hold is the Original's.
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

### A wording fix reaches Our Version lines

An editor's pick of a Canonical Ingredient or FDC food fixes the wording for every Our Version line with it, in every recipe, as it does for the Original's lines, by the same rule:

- A line with the same preparation takes the editor's food, and its open issues on its match and conversion are settled.
- A line with another preparation takes the Canonical Ingredient, and its food goes unconfirmed, since nobody confirmed that food for it. It gets an Enrichment Issue at `our_version.iN.match` asking an editor to pick its food, and a Ready Our Version becomes `awaiting_review`.
- Once a fix or a save settles the last open issue on Our Version, an `awaiting_review` Our Version is `ready`.
- Issues on `our_version.*` aren't Review Items until TaylorZowtuk/recipes#169 shows them.

## Why

- **Substitutions on a line Our Version doesn't otherwise change** (TaylorZowtuk/recipes#170) need a home that isn't an edit of the line. With facts inside `edit`, a substitution would need a copied parse and text, and the line would show as changed.
- **Step Segments** (TaylorZowtuk/recipes#169) go at `our_version.sN.segments`, beside the line facts, with nothing new to look them up.
- **The code that works on facts by path works on the overlay as it is**: `fact_at`, the wording spread (`SharedMatch`) and `confirm_matches` take a `RecipeFacts`. With facts inside each line, every one of them would need a second resolver that searches `edit` (a map) and `add` (a list).
- Nothing is stored in production yet, so the shape changes with no migration.

## Considered options

- **Facts inside each `edit` and `add` entry, as the data model ADR's example has them:** rejected, because #170 and #169 would each add a second home for overlay facts, and the fact-path code couldn't see them.
- **Inline facts, plus a substitutions map for unchanged lines:** rejected as two homes for one kind of thing.

## Consequences

- An Our Version line's facts aren't always the editor's: a wording fixed on another line can change its match, and for another preparation leave it unconfirmed, with provenance `editor` but no one's confirmation.
- An Our Version can be `awaiting_review` before `enrich` has looked at it, with issues the PWA doesn't list until #169. Its lines still scale and shop as they are meanwhile.
- Removing Our Version settles its open issues, and an id one of them names is never given to a new added line or step, so an old issue never lands on a new line.
- A save settles the open issues only of the lines and steps it changes or drops, so the issues #169 and #170 add on the ones it keeps stay open.
