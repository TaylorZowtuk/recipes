# A change to the Original flags Our Version's steps, and each issue says whether a confirm settles it

Supersedes in part [Our Version's lines are the editor's, and its steps wait for enrich under an Our Version Status](2026-11-18-our-version-lines-are-the-editors-steps-wait-for-enrich.md), where Step Portions add up to at most 1 across the effective steps with no exception, and an affected step is settled "by editing the step in Our Version or by confirming it as it is" with no word on the other issues. It also changes the Re-enrichment entry in `CONTEXT.md`, where Our Version and its issues "stay as they are".

An editor can change the Original's steps after Our Version exists: a Review step edit, or a re-enrichment of the Original. Either can give an unchanged step a larger Step Portion of a line an Our Version step also uses, so the effective total goes past 1. The Original's own check doesn't see it, and refusing the change would block the Original's review for Our Version's sake (TaylorZowtuk/recipes#169).

## Decision

### An Original change past 1 flags the Our Version step

- A Review step edit or a re-enrichment that takes a line past 1 across the Original's own steps is refused, as before. The Original alone stays strict.
- One that takes a line past 1 only across the effective steps is not refused. Each Our Version step that uses the line gets an Enrichment Issue naming the other steps ("Step 1 uses stewing beef too: together more than all of it"). A Ready Our Version becomes Awaiting Review.
- While the issue is open, the effective total may sit past 1, and the step shows more of the line than the line has.
- A step gets one such issue per line it overuses. An open issue on the step about another line doesn't stop it.

### Re-enrichment checks Our Version's steps too

- Re-enriching the Original runs the same checks an Our Version save runs on unchanged steps. A step whose new facts mention a line Our Version removed or renamed gets the affected-step issue, and a line past 1 gets the over-use issue above.
- The open issues of a step whose facts it replaced are settled, as they are about facts that are gone.
- So re-enrichment can now give Our Version issues and move it from Ready to Awaiting Review. Our Version's own facts stay as they are.

### Each issue records whether confirming the step as it is settles it

- An issue that proposes no correction records, on the issue, whether confirming its step as it is settles it. The API's confirm and the PWA both read that, not where the issue sits or what its reason says.
- The affected-step issue and the cap's issue (an enrich answer past 1, stored at what's left) settle by confirming the step as it is, or by editing it. The capped Segment is already within 1, and a step that mentions a removed line may still read right.
- The over-use issue settles only by an edit. Confirming the step leaves it open, so Our Version can't become Ready while a line is used past 1.

## Why

- **The Original is still cookable**, and its steps keep counting in Needs Review. An editor fixing it, or a stale recipe being re-enriched, shouldn't fail because of a household's edit elsewhere. Our Version's steps are Our Version's to fix.
- **Flagging keeps the rule visible.** The total is past 1 only while an open issue says so, and Our Version can't be Ready until an edit fixes it.
- **An over-use is a real error**, unlike a capped Segment or a step that mentions a removed line. Confirming it as it is would make Our Version Ready with a step that shows more than the line has.
- **One recorded answer can't drift.** Deciding by an issue's place or reason needs the same rule in the API and the PWA, and they had already disagreed.

## Consequences

- An effective total of Step Portions can sit past 1, always with an open Enrichment Issue on an Our Version step.
- Re-enrichment and Review step edits can move Our Version from Ready to Awaiting Review.
- An Enrichment Issue has one more field, and the generated API client changes with it.
- An editor who sees an over-use flag must edit a step to settle it.

## Considered options

- **Refuse the Original change:** rejected, because the editor would have to edit Our Version before fixing the Original, and a stale re-enrichment would fail on every recipe with Our Version.
- **Cap the Original's step instead:** rejected, because it changes the Original's facts for Our Version's sake.
- **Settle by where the issue sits** (any no-correction issue on a step settles by confirming it): rejected, because it lets an over-use be confirmed away.
- **Settle by the issue's reason:** rejected as string matching, still written twice.
