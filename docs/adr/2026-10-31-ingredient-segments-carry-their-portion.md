# Ingredient segments carry their portion

The [recipe data model ADR](2026-09-29-recipe-data-model.md)'s "Step text" section gives an `ingredient` segment only a `ref` and the words `written`, and renders it as the ingredient × the step's one `uses` portion for that line × the scale. This supersedes that shape. Each `ingredient` segment carries its own `portion`, and renders as the ingredient × its own portion × the scale. A step's `uses` stays, one per line, with each portion the sum of that line's segments' portions in the step. Everything else in the data model ADR stands.

We chose this because a step can name a line twice. In "Melt half the butter, add the onions, then stir in the rest of the butter", with 4 tbsp of butter, one portion per line per step is 1.0, so both mentions showed 4 tbsp. Each mention has to show its own share: 2 tbsp, then 2 tbsp.

## The segment's shape

```json
{"t": "ingredient", "ref": "i3", "written": "half the butter", "portion": 0.5}
```

- **`portion`:** more than 0 and at most 1, the share of the line this mention uses. The model gives it for each phrase in its Work Packet answer, as it did before.
- **`uses`:** each line's portions in the step, summed, at most 1. Across all of a recipe's steps, a line's portions add up to at most 1, within a floating-point tolerance.
- **A step with uses and no segments:** allowed, for a step that uses lines without naming one ("Whisk the sauce ingredients"). Where a step has segments, its uses are exactly its segments' portions summed per line.

## Considered options

- **One ingredient segment per line per step:** rejected. The second mention would stay as written, so the example reads "Melt 4 tbsp butter … the rest of the butter", which misreads the amount.
- **Look up each segment's portion in the step's uses, as before:** rejected, because it shows the step's total at every mention.
