# Ingredient segments carry their portion

The [recipe data model ADR](2026-09-29-recipe-data-model.md)'s "Step text" section gives an `ingredient` segment only a `ref` and the words `written`, and renders it as the ingredient × the step's one `uses` portion for that line × the scale. This supersedes that shape. Each `ingredient` segment carries its own `portion`, and renders as the ingredient × its own portion × the scale. A step's `uses` stays, one per line, with each Step Portion the sum of that line's segments' Step Portions in the step. Everything else in the data model ADR stands.

We chose this because a step can name a line twice. In "Melt half the butter, add the onions, then stir in the rest of the butter", with 4 tbsp of butter, one Step Portion per line per step is 1.0, so both mentions showed 4 tbsp. Each mention has to show its own Step Portion: 2 tbsp, then 2 tbsp.

## The segment's shape

```json
{"t": "ingredient", "ref": "i3", "written": "half the butter", "portion": 0.5}
```

- **`portion`:** more than 0 and at most 1, the Step Portion of the line this mention uses. The model gives it for each phrase in its Work Packet answer, as it did before.
- **`uses`:** each line's Step Portions in the step, summed, at most 1. Across all of a recipe's steps, a line's Step Portions add up to at most 1, within a floating-point tolerance.
- **A step with uses and no segments:** allowed, for a step that uses lines without naming one ("Whisk the sauce ingredients"). Where a step has segments, its uses are exactly its segments' Step Portions summed per line.

## Consequences

- Inside a step, `uses` repeats what the segments say, and the API refuses an enrichment where they disagree.
- A step with segments can use only the lines it names. "Whisk the sauce ingredients for 2 minutes" gets its duration segment or uses of the sauce lines, not both.
- `uses` stays because it gives a step's total Step Portion per line without walking its segments, and because a step can have uses and no segments.

## Considered options

- **One ingredient segment per line per step:** rejected. The second mention would stay as written, so the example reads "Melt 4 tbsp butter … the rest of the butter", which misreads the amount.
- **Look up each segment's portion in the step's uses, as before:** rejected, because it shows the step's total at every mention.
