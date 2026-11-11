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
    MAX_RECIPE_BYTES,
    MAX_SUBSTITUTES,
    PORTION_TOLERANCE,
    SCHEMA_VERSION,
    CanonicalIngredient,
    ConversionFact,
    Difficulty,
    DifficultyFact,
    DurationSegment,
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
    new_ulid,
    normalize_wording,
    resolve,
    settled,
    unit_kind,
)
from recipes.store import ATTEMPTS, VersionConflict

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping

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


def _confirmed(now: datetime) -> dict[str, object]:
    """What confirming a fact records: never the editor's email."""
    return {"confirmed": True, "confirmed_by": CONFIRMED_BY, "confirmed_at": now}


def _editors(now: datetime) -> dict[str, object]:
    """The provenance of a fact the editor wrote: Confirmed, in no Confirm Batch."""
    return {"provenance": "editor", "confidence": 1, "confirm_batch": None, **_confirmed(now)}


def _by_editor[F: Fact](fact: F, now: datetime, **changes: object) -> F:
    """The fact as the editor wrote it."""
    return fact.model_copy(update={**_editors(now), **changes})


def _new_by_editor[F: Fact](kind: type[F], now: datetime, **fields: object) -> F:
    """A fact the editor wrote where there was none."""
    return kind.model_validate({**_editors(now), "estimated": False, **fields})


def _checked[F: Fact](fact: F | None, now: datetime) -> F | None:
    """The fact Confirmed as it stands, keeping any Confirm Batch it was already confirmed in."""
    if fact is None or fact.confirmed:
        return fact
    return fact.model_copy(update=_confirmed(now))


@dataclass
class SharedMatch:
    """A wording's match as an editor fixed it, for every line in the Collection with it."""

    wording: str
    match: MatchFact
    conversion: ConversionFact | None

    def lines(self, recipe: Recipe) -> list[str]:
        """The recipe's lines with the wording."""
        return [
            line_id
            for line_id, line in recipe.facts.ingredients.items()
            if line.parse and normalize_wording(line.parse.name) == self.wording
        ]

    def apply(self, recipe: Recipe) -> Recipe | None:
        """The recipe with each of its lines with the wording matched, or None if it has none.
        Open issues on those lines' matches and conversions are resolved.
        """
        lines = self.lines(recipe)
        if not lines:
            return None
        facts = recipe.facts.model_copy(deep=True)
        for line_id in lines:
            line = facts.ingredients[line_id]
            line.match, line.conversion = self.match, self.conversion
        fixed = {f"{line_id}.{kind}" for line_id in lines for kind in ("match", "conversion")}
        issues = resolve(recipe, lambda fact_id: fact_id in fixed)
        return settled(recipe.model_copy(update={"facts": facts, "issues": issues}))


@dataclass
class Edited:
    """An edited recipe, and what else the edit writes with it."""

    recipe: Recipe
    confirmed: list[CanonicalIngredient] = field(default_factory=list[CanonicalIngredient])
    created: list[CanonicalIngredient] = field(default_factory=list[CanonicalIngredient])
    learned: list[Wording] = field(default_factory=list[Wording])
    fixed: list[Wording] = field(default_factory=list[Wording])
    shared: SharedMatch | None = None
    others: list[str] = field(default_factory=list[str])  # other recipes with the wording


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
    renamed = old is not None and normalize_wording(edit.name) != normalize_wording(old.name)
    if renamed and line.match and not edit.canonical:
        # Keeping the match would confirm the old Canonical Ingredient for the new wording.
        raise HTTPException(422, "Changing the wording needs a Canonical Ingredient choice")
    line.parse = _new_by_editor(
        ParseFact,
        now,
        quantity=edit.quantity,
        unit=edit.unit,
        unit_kind=_unit_kind(old, edit.unit),
        name=edit.name,
        short_name=old.short_name if old and old.name == edit.name else None,
        preparation=edit.preparation,
        comment=old.comment if old else None,
        optional=old.optional if old else False,
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
            result.others = [o.id for o in recipes if o.id != recipe.id and shared.lines(o)]
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
    result.recipe = settled(base.model_copy(update={"facts": facts, "issues": issues}))
    return result


def _unit_kind(old: ParseFact | None, unit: str | None) -> Literal["mass", "volume", "count"]:
    """The line's unit's kind: as the parser read it when the unit is unchanged, since the parser
    decides by the unit's dimension, which the API's tables may not know, and else by the tables.
    """
    if old and old.unit == unit and old.unit_kind:
        return old.unit_kind
    return unit_kind(unit)


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
    match = _new_by_editor(
        MatchFact, now, canonical_id=canonical_id, fdc_id=fdc_id, portion_id=portion_id
    )
    conversion = donor.conversion if donor else None
    if conversion:
        # An editor kept the donor line in its written unit, which says nothing about this one.
        converts = conversion.density_g_per_ml is not None or conversion.grams_per_count is not None
        refused = None if conversion.refused == EDITOR_KEPT and converts else conversion.refused
        conversion = _by_editor(conversion, now, refused=refused)
    return SharedMatch(wording, match, conversion)


def _kept(conversion: ConversionFact | None, *, keep: bool, now: datetime) -> ConversionFact:
    """The conversion kept in the line's written unit, or converting to a weight again."""
    if conversion is None:
        raise HTTPException(422, "The line has no weight to keep or convert")
    if keep:
        return _by_editor(conversion, now, refused=EDITOR_KEPT)
    if conversion.density_g_per_ml is None and conversion.grams_per_count is None:
        raise HTTPException(422, "The line's FDC food gives nothing to convert it by")
    return _by_editor(conversion, now, refused=None)


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
        step.segments = _by_editor(step.segments, now, segments=segments, estimated=False)
    elif step.uses and len(edit.portions) == len(step.uses.uses) and not edit.durations:
        uses = [
            use.model_copy(update={"portion": portion})
            for use, portion in zip(step.uses.uses, edit.portions, strict=True)
        ]
    else:
        raise HTTPException(422, f"Step {edit.step_id} has no such portions or timers")
    step.uses = (
        _by_editor(step.uses, now, uses=uses, estimated=False)
        if step.uses
        else _new_by_editor(UsesFact, now, uses=uses)
    )
    facts.steps[edit.step_id] = step
    if over := overused(facts.steps):
        raise HTTPException(422, f"The steps use more than all of {', '.join(over)}")
    issues = resolve(recipe, lambda fact_id: item_of(fact_id) == edit.step_id)
    return settled(recipe.model_copy(update={"facts": facts, "issues": issues}))


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
    line.substitutions = _by_editor(swaps, now, items=items, estimated=False) if items else None
    item = f"{edit.line_id}.substitutions"
    issues = resolve(recipe, lambda fact_id: fact_id == item)
    return settled(recipe.model_copy(update={"facts": facts, "issues": issues}))


def _edit_difficulty(recipe: Recipe, edit: EditDifficulty, now: datetime) -> Recipe:
    difficulty = Difficulty(prep=edit.prep, cook=edit.cook, cleanup=edit.cleanup)
    facts = recipe.facts.model_copy(deep=True)
    facts.difficulty = _new_by_editor(DifficultyFact, now, **difficulty.model_dump())
    issues = resolve(recipe, lambda fact_id: fact_id == "difficulty")
    changes = {"facts": facts, "issues": issues, "difficulty": difficulty}
    return settled(recipe.model_copy(update=changes))


def share_all(store: Store, edited: Edited) -> tuple[list[str], list[str]]:
    """Match every other recipe's lines with the wording as the editor fixed it, each at its own
    version, after the edited recipe is saved. The recipes updated, and those not updated because
    they kept changing or would be too big: saving the line again repairs them.
    """
    updated: list[str] = []
    not_updated: list[str] = []
    if edited.shared is None:
        return updated, not_updated
    for recipe_id in edited.others:
        match _share(store, recipe_id, edited.shared):
            case "updated":
                updated.append(recipe_id)
            case "not_updated":
                not_updated.append(recipe_id)
            case "gone":
                pass
    return updated, not_updated


def _share(
    store: Store, recipe_id: str, shared: SharedMatch
) -> Literal["updated", "not_updated", "gone"]:
    """Match one recipe's lines with the wording, reading it again if it changed meanwhile."""
    for _ in range(ATTEMPTS):
        current = store.get_recipe(recipe_id)
        changed = shared.apply(current) if current else None
        if changed is None:
            return "gone"  # deleted, or its line no longer has the wording
        if len(changed.model_dump_json().encode()) > MAX_RECIPE_BYTES:
            return "not_updated"
        try:
            store.update_recipe(changed)
        except VersionConflict:
            continue
        return "updated"
    return "not_updated"


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
