"""Step Portions across the effective steps: a line's add up to at most 1. A change to the
Original alone that takes a line past that isn't refused, as Our Version's steps are Our
Version's to fix: each Our Version step that uses the line is flagged, settled only by an edit
that brings the line back within all of it, or of the Our Version step.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from recipes.models import (
    OUR_VERSION,
    PORTION_TOLERANCE,
    EnrichmentIssue,
    IngredientSegment,
    effective,
    new_ulid,
    our_version_settled,
)

if TYPE_CHECKING:
    from collections.abc import Mapping

    from recipes.models import Effective, Recipe, StepFacts


def overused(steps: Mapping[str, StepFacts]) -> list[str]:
    """The lines the steps use more than all of, across every step."""
    portions: dict[str, float] = {}
    for facts in steps.values():
        for use in facts.uses.uses if facts.uses else []:
            portions[use.ref] = portions.get(use.ref, 0) + use.portion
    return sorted(ref for ref, total in portions.items() if total > 1 + PORTION_TOLERANCE)


def flag_overused(recipe: Recipe) -> Recipe:
    """The recipe with an issue on each Our Version step that uses a line the effective steps use
    more than all of, naming the other steps, unless the step has one open for that line already,
    whose wording is brought up to date. Such an issue whose line is back within all of it is
    resolved, as an edit settles it.
    """
    if recipe.our_version is None:
        return recipe
    shown = effective(recipe)
    reasons: dict[tuple[str, str], str] = {}
    steps: dict[tuple[str, str], str] = {}
    for ref in overused(shown.facts.steps):
        users = {i for i, facts in shown.facts.steps.items() if ref in refs(facts)}
        said = f"{line_name(shown, ref)} too: together more than all of it"
        for step in shown.steps:
            if step.change and step.id in users:
                flag = (f"{OUR_VERSION}{step.id}.uses", ref)
                reasons[flag] = f"{steps_use(shown, users - {step.id})} {said}"
                steps[flag] = step.id
    open_flags = {(i.fact_id, str(i.line_id)) for i in recipe.issues if _flag(i)}
    issues = [
        step_issue(steps[flag], reason, line_id=flag[1])
        for flag, reason in reasons.items()
        if flag not in open_flags
    ]
    gone = open_flags - reasons.keys()
    kept = [_refreshed(i, reasons, gone) if _flag(i) else i for i in recipe.issues]
    updated = flagged(recipe.model_copy(update={"issues": kept}), issues)
    return our_version_settled(updated) if gone else updated


def _refreshed(
    issue: EnrichmentIssue, reasons: dict[tuple[str, str], str], gone: set[tuple[str, str]]
) -> EnrichmentIssue:
    """The open flag resolved if its line is back within all of it, else with its wording now."""
    key = (issue.fact_id, str(issue.line_id))
    if key in gone:
        return issue.model_copy(update={"status": "resolved", "confirm_batch": None})
    return issue.model_copy(update={"reason": reasons[key]})


def _flag(issue: EnrichmentIssue) -> bool:
    """Whether the issue is an open one that steps use more than all of its line."""
    return issue.status == "open" and issue.line_id is not None


def refs(facts: StepFacts | None) -> set[str]:
    """The lines a step's Segments and uses are for."""
    if facts is None:
        return set()
    segments = facts.segments.segments if facts.segments else []
    uses = facts.uses.uses if facts.uses else []
    named = {s.ref for s in segments if isinstance(s, IngredientSegment)}
    return named | {use.ref for use in uses}


def line_name(shown: Effective, line_id: str) -> str:
    """A line as a message names it: its parsed name, or else its text."""
    facts = shown.facts.ingredients.get(line_id)
    if facts and facts.parse:
        return facts.parse.name
    return next(line.text for line in shown.ingredients if line.id == line_id)


def steps_use(shown: Effective, step_ids: set[str]) -> str:
    """ "Step 1 uses" or "Steps 1 and 4 use", by where the steps are in the effective recipe."""
    numbers = [str(n) for n, step in enumerate(shown.steps, 1) if step.id in step_ids]
    if len(numbers) == 1:
        return f"Step {numbers[0]} uses"
    return f"Steps {', '.join(numbers[:-1])} and {numbers[-1]} use"


def step_issue(
    step_id: str, reason: str, *, settles_on_confirm: bool = False, line_id: str | None = None
) -> EnrichmentIssue:
    """An issue on an Our Version step's uses that proposes no correction."""
    return EnrichmentIssue(
        id=new_ulid(),
        fact_id=f"{OUR_VERSION}{step_id}.uses",
        reason=reason,
        settles_on_confirm=settles_on_confirm,
        line_id=line_id,
    )


def flagged(recipe: Recipe, issues: list[EnrichmentIssue]) -> Recipe:
    """The recipe with these issues added, and its Our Version Awaiting Review if it was Ready."""
    if not issues:
        return recipe
    changes: dict[str, object] = {"issues": [*recipe.issues, *issues]}
    if recipe.our_version_status == "ready":
        changes |= {"our_version_status": "awaiting_review", "our_version_ready_batch": None}
    return recipe.model_copy(update=changes)
