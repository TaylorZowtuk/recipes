"""An editor's edit of one Review Item's facts: a line, a step, a substitution or the Difficulty.

An edit saves its facts Confirmed with provenance `editor`, in no Confirm Batch, so no undo
reverses it. A line's new Canonical Ingredient fixes its wording: the Wording Cache confirms it,
and every line in the Collection with that wording is matched to it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Annotated, Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field, StringConstraints, model_validator

from recipes.models import (
    MAX_LABEL,
    MAX_LINES,
    MAX_SUBSTITUTES,
    PORTION_TOLERANCE,
    SCHEMA_VERSION,
    CanonicalIngredient,
    ConversionFact,
    Difficulty,
    DifficultyFact,
    DurationSegment,
    EnrichmentIssue,
    Fact,
    IngredientFacts,
    IngredientSegment,
    Label,
    MatchFact,
    ParseFact,
    Portion,
    Quantity,
    Ratio,
    Recipe,
    RecipeFacts,
    Segment,
    StepFacts,
    StepUse,
    Ulid,
    UsesFact,
    Wording,
    item_of,
    needs_review,
    new_ulid,
    normalize_wording,
    unit_kind,
)
from recipes.store import ATTEMPTS, VersionConflict

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable, Mapping

    from recipes.store import Store

# Who confirmed a fact, as recipes record it: never the editor's email, because recipes are public
# and cached for good.
CONFIRMED_BY = "editor"
# The reason a line an editor chose to keep in its written unit doesn't convert to a weight.
EDITOR_KEPT = "kept in the written unit by an editor"

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_LABEL)]


class ExistingCanonical(BaseModel):
    """Match the line to a Canonical Ingredient already in the Collection."""

    kind: Literal["existing"]
    id: Ulid


class NewCanonical(BaseModel):
    """Match the line to a new Canonical Ingredient, created Confirmed."""

    kind: Literal["new"]
    name: Name
    family: Name
    store_category_id: str


CanonicalChoice = Annotated[ExistingCanonical | NewCanonical, Field(discriminator="kind")]


class EditLine(BaseModel):
    """A line's amount, unit, wording and preparation as the editor reads it, and, if given, its
    new Canonical Ingredient and whether it keeps its written unit (true) or converts to a weight
    (false). No quantity means no amount, as in "to taste".
    """

    kind: Literal["line"]
    line_id: Label
    quantity: Quantity | None
    unit: Label | None
    name: Name
    preparation: Label | None
    canonical: CanonicalChoice | None = None
    keep_weight: bool | None = None


class StepTimer(BaseModel):
    low_s: Annotated[int, Field(gt=0)]
    high_s: Annotated[int, Field(gt=0)]

    @model_validator(mode="after")
    def _runs_upward(self) -> StepTimer:
        if self.high_s < self.low_s:
            msg = "A timer's high_s is at least its low_s"
            raise ValueError(msg)
        return self


class EditStep(BaseModel):
    """A step's Step Portions, one for each of its ingredient segments in order (or, in a step
    without segments, for each line it uses), and its timers, one for each duration segment.
    """

    kind: Literal["step"]
    step_id: Label
    portions: Annotated[list[Portion], Field(max_length=MAX_LINES)]
    durations: Annotated[list[StepTimer], Field(max_length=MAX_LINES)]


SubstituteIndex = Annotated[int, Field(ge=0, lt=MAX_SUBSTITUTES)]


class EditSubstitution(BaseModel):
    """The ratio and note of the line's substitute at `index`."""

    kind: Literal["substitution"]
    line_id: Label
    index: SubstituteIndex
    ratio: Ratio
    note: Label


class RemoveSubstitution(BaseModel):
    """Remove the line's substitute at `index`. Removing the last leaves the line none."""

    kind: Literal["remove_substitution"]
    line_id: Label
    index: SubstituteIndex


class EditDifficulty(Difficulty):
    """The recipe's Difficulty, which is also saved as the confirmed suggestion."""

    kind: Literal["difficulty"]


FactEdit = Annotated[
    EditLine | EditStep | EditSubstitution | RemoveSubstitution | EditDifficulty,
    Field(discriminator="kind"),
]


def by_editor[F: Fact](fact: F, now: datetime, **changes: object) -> F:
    """The fact as the editor wrote it: Confirmed, in no Confirm Batch."""
    return fact.model_copy(
        update={
            "provenance": "editor",
            "confidence": 1,
            "confirmed": True,
            "confirmed_by": CONFIRMED_BY,
            "confirmed_at": now,
            "confirm_batch": None,
            **changes,
        }
    )


def _checked[F: Fact](fact: F | None, now: datetime) -> F | None:
    """The fact Confirmed as it stands, keeping any Confirm Batch it was already confirmed in."""
    if fact is None or fact.confirmed:
        return fact
    return fact.model_copy(
        update={"confirmed": True, "confirmed_by": CONFIRMED_BY, "confirmed_at": now}
    )


EDITOR: dict[str, object] = {
    "provenance": "editor",
    "confidence": 1,
    "estimated": False,
    "confirmed": True,
    "confirmed_by": CONFIRMED_BY,
}


@dataclass
class SharedMatch:
    """A wording's match as an editor fixed it, for every line in the Collection with it."""

    wording: str
    match: MatchFact
    conversion: ConversionFact | None

    def apply(self, recipe: Recipe) -> Recipe | None:
        """The recipe with each of its lines with the wording matched, or None if it has none.
        Open issues on those lines' matches and conversions are resolved.
        """
        facts = recipe.facts.model_copy(deep=True)
        lines = [
            line_id
            for line_id, line in facts.ingredients.items()
            if line.parse and normalize_wording(line.parse.name) == self.wording
        ]
        if not lines:
            return None
        for line_id in lines:
            line = facts.ingredients[line_id]
            line.match, line.conversion = self.match, self.conversion
        fixed = {f"{line_id}.{kind}" for line_id in lines for kind in ("match", "conversion")}
        return settled(recipe, facts, resolve(recipe, lambda fact_id: fact_id in fixed))


def resolve(recipe: Recipe, on: Callable[[str], bool]) -> list[EnrichmentIssue]:
    """The recipe's issues, with the open ones on facts `on` picks resolved, in no batch."""
    return [
        issue.model_copy(update={"status": "resolved", "confirm_batch": None})
        if issue.status == "open" and on(issue.fact_id)
        else issue
        for issue in recipe.issues
    ]


def settled(
    recipe: Recipe, facts: RecipeFacts, issues: list[EnrichmentIssue], **changes: object
) -> Recipe:
    """The recipe with its edited facts and issues: Ready if it was Awaiting Review and nothing
    is left to check, though no Confirm Batch made it so.
    """
    edited = recipe.model_copy(update={"facts": facts, "issues": issues, **changes})
    if edited.status == "awaiting_review" and needs_review(edited).unconfirmed == 0:
        edited = edited.model_copy(update={"status": "ready"})
    return edited


@dataclass
class Edited:
    """An edited recipe, and what else the edit writes with it."""

    recipe: Recipe
    confirmed: list[CanonicalIngredient] = field(default_factory=list[CanonicalIngredient])
    created: list[CanonicalIngredient] = field(default_factory=list[CanonicalIngredient])
    learned: list[Wording] = field(default_factory=list[Wording])
    fixed: list[Wording] = field(default_factory=list[Wording])
    shared: SharedMatch | None = None
    others: list[Recipe] = field(default_factory=list[Recipe])


def edit_recipe(store: Store, recipe: Recipe, edit: FactEdit) -> Edited:
    """The recipe with the edit applied. Raises a 422 for an edit it can't take."""
    now = datetime.now(UTC)
    match edit:
        case EditLine():
            return _edit_line(store, recipe, edit, now)
        case EditStep():
            return Edited(_edit_step(recipe, edit, now))
        case EditSubstitution() | RemoveSubstitution():
            return Edited(_edit_substitution(recipe, edit, now))
        case EditDifficulty():
            return Edited(_edit_difficulty(recipe, edit, now))


def _edit_line(store: Store, recipe: Recipe, edit: EditLine, now: datetime) -> Edited:
    if edit.line_id not in {line.id for line in recipe.original.ingredients}:
        raise HTTPException(422, f"The recipe has no line {edit.line_id}")
    facts = recipe.facts.model_copy(deep=True)
    line = facts.ingredients.setdefault(edit.line_id, IngredientFacts())
    old = line.parse
    line.parse = ParseFact.model_validate(
        {
            **EDITOR,
            "confirmed_at": now,
            "quantity": edit.quantity,
            "unit": edit.unit,
            "unit_kind": unit_kind(edit.unit),
            "name": edit.name,
            "short_name": old.short_name if old and old.name == edit.name else None,
            "preparation": edit.preparation,
            "comment": old.comment if old else None,
            "optional": old.optional if old else False,
        }
    )
    result, base = Edited(recipe), recipe
    if edit.canonical:
        canonical = _canonical(store, edit.canonical, result)
        recipes = store.recipes()
        shared = _shared_match(recipes, canonical.id, normalize_wording(edit.name), now)
        line.match, line.conversion = shared.match, shared.conversion
        if shared.wording:
            result.shared = shared
            result.fixed = [
                Wording(
                    wording=shared.wording,
                    canonical_id=canonical.id,
                    confirmed=True,
                    schema_version=SCHEMA_VERSION,
                )
            ]
            others = (other for other in recipes if other.id != recipe.id)
            result.others = [other for other in others if shared.apply(other)]
            # The recipe's other lines with the same wording take the match too.
            base = shared.apply(recipe.model_copy(update={"facts": facts})) or base
            facts = base.facts
            line = facts.ingredients[edit.line_id]
    else:
        line.match, line.conversion = _checked(line.match, now), _checked(line.conversion, now)
        if line.match:
            canonicals, wordings = confirm_matches(store, facts, [f"{edit.line_id}.match"], None)
            result.confirmed, result.learned = canonicals, wordings
    if edit.keep_weight is not None:
        line.conversion = _kept(line.conversion, keep=edit.keep_weight, now=now)
    issues = resolve(base, lambda fact_id: item_of(fact_id) == edit.line_id)
    result.recipe = settled(base, facts, issues)
    return result


def _canonical(store: Store, choice: CanonicalChoice, result: Edited) -> CanonicalIngredient:
    """The Canonical Ingredient the editor chose: an existing one, Confirmed if it wasn't, or a
    new one, created Confirmed in one of the Kitchen settings' Store Categories.
    """
    if isinstance(choice, ExistingCanonical):
        canonical = store.canonical_ingredient(choice.id)
        if canonical is None:
            raise HTTPException(422, f"No Canonical Ingredient {choice.id}")
        if not canonical.confirmed:
            result.confirmed = [canonical.model_copy(update={"confirmed": True})]
        return canonical
    categories = {category.id for category in store.kitchen_settings().store_categories}
    if choice.store_category_id not in categories:
        raise HTTPException(422, "The new Canonical Ingredient's Store Category doesn't exist")
    canonical = CanonicalIngredient(
        id=new_ulid(),
        name=choice.name,
        family=choice.family,
        store_category_id=choice.store_category_id,
        confirmed=True,
        version=1,
        schema_version=SCHEMA_VERSION,
    )
    result.created = [canonical]
    return canonical


def _shared_match(
    recipes: Iterable[Recipe], canonical_id: str, wording: str, now: datetime
) -> SharedMatch:
    """The match for a line the editor matched to the Canonical Ingredient, with the FDC food and
    conversion of a line already matched to it, a Confirmed one first. A conversion is the FDC
    food and portion's, not the line's, so it carries over. With no such line, there's no FDC
    food and no conversion, rather than a made-up one.
    """
    donors = [
        line
        for recipe in recipes
        for line in recipe.facts.ingredients.values()
        if line.match and line.match.canonical_id == canonical_id and line.match.fdc_id is not None
    ]
    donor = next((line for line in donors if line.match and line.match.confirmed), None)
    donor = donor or next(iter(donors), None)
    fdc_id, portion_id = (
        (donor.match.fdc_id, donor.match.portion_id) if donor and donor.match else (None, None)
    )
    match = MatchFact.model_validate(
        {
            **EDITOR,
            "confirmed_at": now,
            "canonical_id": canonical_id,
            "fdc_id": fdc_id,
            "portion_id": portion_id,
        }
    )
    conversion = donor.conversion if donor else None
    if conversion:
        # An editor kept the donor line in its written unit, which says nothing about this one.
        converts = conversion.density_g_per_ml is not None or conversion.grams_per_count is not None
        refused = None if conversion.refused == EDITOR_KEPT and converts else conversion.refused
        conversion = by_editor(conversion, now, refused=refused)
    return SharedMatch(wording, match, conversion)


def _kept(conversion: ConversionFact | None, *, keep: bool, now: datetime) -> ConversionFact:
    """The conversion kept in the line's written unit, or converting to a weight again."""
    if conversion is None:
        raise HTTPException(422, "The line has no weight to keep or convert")
    if keep:
        return by_editor(conversion, now, refused=EDITOR_KEPT)
    if conversion.density_g_per_ml is None and conversion.grams_per_count is None:
        raise HTTPException(422, "The line's FDC food gives nothing to convert it by")
    return by_editor(conversion, now, refused=None)


def _edit_step(recipe: Recipe, edit: EditStep, now: datetime) -> Recipe:
    if edit.step_id not in {step.id for step in recipe.original.steps}:
        raise HTTPException(422, f"The recipe has no step {edit.step_id}")
    facts = recipe.facts.model_copy(deep=True)
    step = facts.steps.get(edit.step_id) or StepFacts()
    if step.segments:
        portions, durations = iter(edit.portions), iter(edit.durations)
        segments = [
            segment.model_copy(update={"portion": next(portions)})
            if isinstance(segment, IngredientSegment)
            else segment.model_copy(update=next(durations).model_dump())
            if isinstance(segment, DurationSegment)
            else segment
            for segment in _counted(step.segments.segments, edit)
        ]
        summed: dict[str, float] = {}
        for segment in segments:
            if isinstance(segment, IngredientSegment):
                summed[segment.ref] = summed.get(segment.ref, 0) + segment.portion
        uses = [StepUse(ref=ref, portion=portion) for ref, portion in summed.items()]
        step.segments = by_editor(step.segments, now, segments=segments, estimated=False)
    elif step.uses and len(edit.portions) == len(step.uses.uses) and not edit.durations:
        uses = [
            use.model_copy(update={"portion": portion})
            for use, portion in zip(step.uses.uses, edit.portions, strict=True)
        ]
    else:
        raise HTTPException(422, f"Step {edit.step_id} has no such portions or timers")
    step.uses = (
        by_editor(step.uses, now, uses=uses, estimated=False)
        if step.uses
        else UsesFact.model_validate({**EDITOR, "confirmed_at": now, "uses": uses})
    )
    facts.steps[edit.step_id] = step
    if over := overused(facts.steps):
        raise HTTPException(422, f"The steps use more than all of {', '.join(over)}")
    issues = resolve(recipe, lambda fact_id: item_of(fact_id) == edit.step_id)
    return settled(recipe, facts, issues)


def _counted(segments: list[Segment], edit: EditStep) -> list[Segment]:
    """The step's segments, if the edit has a portion for each ingredient segment and a timer
    for each duration segment.
    """
    ingredients = sum(isinstance(segment, IngredientSegment) for segment in segments)
    durations = sum(isinstance(segment, DurationSegment) for segment in segments)
    if (ingredients, durations) != (len(edit.portions), len(edit.durations)):
        raise HTTPException(
            422,
            f"Step {edit.step_id} has {ingredients} ingredient segments and {durations} timers",
        )
    return segments


def overused(steps: Mapping[str, StepFacts]) -> list[str]:
    """The lines the steps use more than all of, across every step."""
    portions: dict[str, float] = {}
    for facts in steps.values():
        for use in facts.uses.uses if facts.uses else []:
            portions[use.ref] = portions.get(use.ref, 0) + use.portion
    return sorted(ref for ref, total in portions.items() if total > 1 + PORTION_TOLERANCE)


def _edit_substitution(
    recipe: Recipe, edit: EditSubstitution | RemoveSubstitution, now: datetime
) -> Recipe:
    facts = recipe.facts.model_copy(deep=True)
    line = facts.ingredients.get(edit.line_id)
    swaps = line.substitutions if line else None
    if line is None or swaps is None or edit.index >= len(swaps.items):
        raise HTTPException(422, f"Line {edit.line_id} has no substitute {edit.index}")
    items = list(swaps.items)
    if isinstance(edit, EditSubstitution):
        items[edit.index] = items[edit.index].model_copy(
            update={"ratio": edit.ratio, "note": edit.note}
        )
    else:
        del items[edit.index]
    line.substitutions = by_editor(swaps, now, items=items, estimated=False) if items else None
    item = f"{edit.line_id}.substitutions"
    return settled(recipe, facts, resolve(recipe, lambda fact_id: fact_id == item))


def _edit_difficulty(recipe: Recipe, edit: EditDifficulty, now: datetime) -> Recipe:
    difficulty = Difficulty(prep=edit.prep, cook=edit.cook, cleanup=edit.cleanup)
    facts = recipe.facts.model_copy(deep=True)
    facts.difficulty = DifficultyFact.model_validate(
        {**EDITOR, "confirmed_at": now, **difficulty.model_dump()}
    )
    issues = resolve(recipe, lambda fact_id: fact_id == "difficulty")
    return settled(recipe, facts, issues, difficulty=difficulty)


def share(store: Store, recipe_id: str, shared: SharedMatch) -> bool:
    """Match another recipe's lines with the wording as the editor fixed it, at its own version,
    reading it again if it changed meanwhile. False if it no longer has such a line.
    """
    for _ in range(ATTEMPTS):
        current = store.get_recipe(recipe_id)
        changed = shared.apply(current) if current else None
        if changed is None:
            return False
        try:
            store.update_recipe(changed)
        except VersionConflict:
            continue
        return True
    raise VersionConflict(recipe_id)


def confirm_matches(
    store: Store, facts: RecipeFacts, confirming: list[str], batch: str | None
) -> tuple[list[CanonicalIngredient], list[Wording]]:
    """The unconfirmed Canonical Ingredients of the matches being confirmed, now Confirmed in
    `batch`, and their lines' wordings, Confirmed unless an editor already confirmed them.
    """
    canonicals: dict[str, CanonicalIngredient] = {}
    wordings: dict[str, Wording] = {}
    for path in confirming:
        line_id, _, kind = path.partition(".")
        line = facts.ingredients.get(line_id)
        if kind != "match" or line is None or line.match is None:
            continue
        canonical_id = line.match.canonical_id
        canonical = store.canonical_ingredient(canonical_id)
        if canonical and not canonical.confirmed:
            canonicals[canonical_id] = canonical.model_copy(
                update={"confirmed": True, "confirm_batch": batch}
            )
        wording = normalize_wording(line.parse.name) if line.parse else ""
        cached = store.wording(wording) if wording else None
        if wording and not (cached and cached.confirmed):
            wordings[wording] = Wording(
                wording=wording,
                canonical_id=canonical_id,
                confirmed=True,
                schema_version=SCHEMA_VERSION,
            )
    return list(canonicals.values()), list(wordings.values())
