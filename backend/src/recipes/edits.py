"""An editor's edit of one Review Item's facts: a line, a step, a substitution or the Difficulty.

An edit saves its facts Confirmed with provenance `editor`, in no Confirm Batch, so no undo
reverses it. A line's new Canonical Ingredient or FDC food fixes its wording: the Wording Cache
confirms it, and every line in the Collection with that wording takes its Canonical Ingredient.
Only a line with exactly the same preparation takes the food, with the portion that fits its own
written unit; a line prepared another way keeps its food, unconfirmed, and is asked for one when its
Canonical Ingredient changed. A line with no match takes the food, unconfirmed if prepared
another way, and is asked for its food too.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Annotated, Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field, StringConstraints, model_validator

from recipes import fdc
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
    new_ulid,
    normalize_wording,
    resolve,
    settled,
    unit_kind,
)
from recipes.store import ATTEMPTS, VersionConflict

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping

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
    """A line's amount, unit, wording and preparation as the editor reads it, its FDC food and
    portion (none chosen is allowed), and, if given, its new Canonical Ingredient and whether it
    keeps its written unit (true) or converts to a weight (false). No quantity means no amount, as
    in "to taste". A line that has or gets a Canonical Ingredient needs an FDC food; a line with
    none has no match, and so no food.
    """

    kind: Literal["line"]
    line_id: Label
    quantity: Quantity | None
    unit: Label | None
    name: Name
    preparation: Label | None
    fdc_id: int | None
    portion_id: int | None
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


def _unconfirmed[F: Fact](fact: F, **changes: object) -> F:
    """The fact as it was, apart from `changes`, and no longer Confirmed: an editor saw none of
    it, so none of it is theirs.
    """
    return fact.model_copy(
        update={
            "confirmed": False,
            "confirmed_by": None,
            "confirmed_at": None,
            "confirm_batch": None,
            **changes,
        }
    )


def _preparation(parse: ParseFact) -> str:
    """The line's preparation as a food pick compares it: as a wording is normalized, and empty
    for none.
    """
    return normalize_wording(parse.preparation or "")


@dataclass
class SharedMatch:
    """A wording's match as an editor fixed it, for every line in the Collection with it. The
    Canonical Ingredient goes to every line. The FDC food goes only to lines with exactly the
    same preparation, since a preparation can change the food ("1 lemon, juiced" is juice, "1
    lemon, cut in wedges" the fruit), and the portion only where it fits the line's own written
    unit. Raises fdc.NotInSnapshot for a food the FDC Snapshot doesn't have or a portion that
    isn't the food's.
    """

    wording: str
    preparation: str
    canonical_id: str
    snapshot: fdc.Snapshot
    fdc_id: int
    portion_id: int | None
    now: datetime
    food: fdc.Food = field(init=False)

    def __post_init__(self) -> None:
        self.food = fdc.chosen(self.snapshot, self.fdc_id, self.portion_id)

    def picked(self, portion_id: int | None) -> tuple[MatchFact, ConversionFact]:
        """A line's match to the food and portion, and the conversion the portion gives."""
        numbers = fdc.numbers(self.snapshot, self.fdc_id, portion_id)
        return (
            _new_by_editor(
                MatchFact,
                self.now,
                canonical_id=self.canonical_id,
                fdc_id=self.fdc_id,
                portion_id=portion_id,
            ),
            _new_by_editor(ConversionFact, self.now, fdc_id=self.fdc_id, **numbers.model_dump()),
        )

    def _takes_food(self, parse: ParseFact) -> bool:
        return _preparation(parse) == self.preparation

    def lines(self, recipe: Recipe) -> list[str]:
        """The recipe's lines the match changes: those with the wording and the preparation, and
        those with the wording and another preparation whose Canonical Ingredient changes.
        """
        return [
            line_id
            for line_id, line in recipe.facts.ingredients.items()
            if line.parse
            and normalize_wording(line.parse.name) == self.wording
            and (
                self._takes_food(line.parse)
                or line.match is None
                or line.match.canonical_id != self.canonical_id
            )
        ]

    def apply(self, recipe: Recipe, picked_on: str | None = None) -> Recipe | None:
        """The recipe with each line the match changes matched, apart from `picked_on`, the line
        the editor picked the food on, or None if it has none. A line with the preparation takes
        the food, its open issues on its match and conversion are resolved, and if no portion of
        the food fits it, an open issue asks an editor to pick one. A line with another
        preparation takes the Canonical Ingredient and keeps its own food, unconfirmed since
        nobody confirmed that food for the new Canonical Ingredient (or takes the food,
        unconfirmed too, if it had none); its open issues on its match are resolved, and an open
        issue asks an editor to pick its food.
        """
        lines = self.lines(recipe)
        if not lines:
            return None
        facts = recipe.facts.model_copy(deep=True)
        asks: list[EnrichmentIssue] = []
        fixed: set[str] = set()
        for line_id in lines:
            line = facts.ingredients[line_id]
            if line.parse is None:
                continue
            takes_food = self._takes_food(line.parse)
            if takes_food or line.match is None:
                fixed |= {f"{line_id}.match", f"{line_id}.conversion"}
            else:
                fixed.add(f"{line_id}.match")
            if line_id == picked_on:
                continue
            if takes_food or line.match is None:
                portion_id, fits = self._portion_for(line.parse)
                line.match, line.conversion = self.picked(portion_id)
                if not takes_food:
                    # Picked for another preparation: nobody confirmed the food for this line.
                    line.match = _unconfirmed(line.match)
                    line.conversion = _unconfirmed(line.conversion)
                if not fits:
                    asks.append(self._ask(line_id, line.parse))
            else:
                line.match = _unconfirmed(line.match, canonical_id=self.canonical_id)
            if not takes_food:
                asks.append(self._ask_food(line_id, line.parse))
        issues = [*resolve(recipe, lambda fact_id: fact_id in fixed), *asks]
        return settled(recipe.model_copy(update={"facts": facts, "issues": issues}))

    def _portion_for(self, parse: ParseFact) -> tuple[int | None, bool]:
        """The food's portion that fits the line's written unit, and whether one does. A weight
        needs no portion, so a mass line takes the chosen one as it is. A volume line takes the
        chosen portion if it gives a density, which works for every volume, or else the food's
        first that does. A count line takes the chosen portion if it counts in the line's word,
        or else the food's first that does. No portion gives a line with no amount ("salt, to
        taste") a weight, so it too takes the chosen one as it is.
        """
        kind = parse.unit_kind or unit_kind(parse.unit)
        line = (kind, parse.unit)
        has_amount = parse.quantity is not None
        for portion_id in [self.portion_id, *(portion.id for portion in self.food.portions)]:
            conversion = fdc.convert(self.food, portion_id)
            if fdc.fits(conversion, *line, has_amount=has_amount):
                return portion_id, True
        return None, False

    def _ask(self, line_id: str, parse: ParseFact) -> EnrichmentIssue:
        """An open issue asking an editor to pick the portion for a line none fits. It proposes
        no correction, so there's nothing to accept: the editor edits the line to pick one.
        """
        unit = f"its unit, {parse.unit}" if parse.unit else "a count with no unit"
        return EnrichmentIssue(
            id=new_ulid(),
            fact_id=f"{line_id}.conversion",
            reason=f"An editor picked {self.food.description} for {self.wording}, but none of "
            f"its portions fits {unit}, so this line has no weight: pick a portion for it.",
        )

    def _ask_food(self, line_id: str, parse: ParseFact) -> EnrichmentIssue:
        """An open issue asking an editor to check the FDC food of a line prepared another way
        than the line the food was picked on: one whose Canonical Ingredient changed, or one with
        no match until now. Like the ask for a portion, it proposes no correction.
        """
        picked_on = f'prepared "{self.preparation}"' if self.preparation else "with no preparation"
        this = f'is prepared "{parse.preparation}"' if parse.preparation else "has no preparation"
        return EnrichmentIssue(
            id=new_ulid(),
            fact_id=f"{line_id}.match",
            reason=f"An editor picked {self.food.description} for {self.wording} on a line "
            f"{picked_on}. This line {this}, so it may need another FDC food: pick one for it.",
        )


@dataclass
class Edited:
    """An edited recipe, and what else the edit writes with it."""

    recipe: Recipe
    confirmed: list[CanonicalIngredient] = field(default_factory=list[CanonicalIngredient])
    created: list[CanonicalIngredient] = field(default_factory=list[CanonicalIngredient])
    learned: list[Wording] = field(default_factory=list[Wording])
    fixed: list[Wording] = field(default_factory=list[Wording])
    shared: SharedMatch | None = None
    # Other recipes the match changes: with the wording, prepared the same way or needing the
    # Canonical Ingredient.
    others: list[str] = field(default_factory=list[str])


def edit_recipe(
    store: Store, recipe: Recipe, edit: FactEdit, snapshot: Callable[[], fdc.Snapshot]
) -> Edited:
    """The recipe with the edit applied, loading the FDC Snapshot only to pick a line's food.
    Raises a 422 for an edit it can't take.
    """
    now = datetime.now(UTC)
    match edit:
        case EditLine():
            return _edit_line(store, recipe, edit, snapshot, now)
        case EditStep():
            return Edited(_edit_step(recipe, edit, now))
        case EditSubstitution() | RemoveSubstitution():
            return Edited(_edit_substitution(recipe, edit, now))
        case EditDifficulty():
            return Edited(_edit_difficulty(recipe, edit, now))


def _edit_line(
    store: Store,
    recipe: Recipe,
    edit: EditLine,
    snapshot: Callable[[], fdc.Snapshot],
    now: datetime,
) -> Edited:
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
    current, picked = line.match, (edit.fdc_id, edit.portion_id)
    kept = ExistingCanonical(kind="existing", id=current.canonical_id) if current else None
    choice = edit.canonical or kept
    if choice is None:
        # No Canonical Ingredient, so no match, and so no food.
        if edit.fdc_id is not None:
            raise HTTPException(
                422, f"Line {edit.line_id} has no Canonical Ingredient, so it takes no FDC food"
            )
    elif edit.fdc_id is None:
        raise HTTPException(422, f"Line {edit.line_id} needs an FDC food: the closest if none fits")
    elif edit.canonical or current is None or (current.fdc_id, current.portion_id) != picked:
        canonical = _canonical(store, choice, result)
        shared = _picked(snapshot(), canonical.id, edit.fdc_id, edit, now)
        line.match, line.conversion = shared.picked(edit.portion_id)
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
            recipes = store.recipes()
            result.others = [o.id for o in recipes if o.id != recipe.id and shared.lines(o)]
            # The recipe's other lines with the wording take the match too, as other recipes'.
            base = shared.apply(recipe.model_copy(update={"facts": facts}), edit.line_id) or base
            facts = base.facts
            line = facts.ingredients[edit.line_id]
    else:
        # The same food and portion: the line's match and conversion are Confirmed as they stand.
        line.match, line.conversion = _checked(line.match, now), _checked(line.conversion, now)
        canonicals, wordings = confirm_matches(store, facts, [f"{edit.line_id}.match"], None)
        result.confirmed, result.learned = canonicals, wordings
    if edit.keep_weight is not None:
        line.conversion = _kept(line.conversion, edit.line_id, keep=edit.keep_weight, now=now)
    issues = resolve(base, lambda fact_id: item_of(fact_id) == edit.line_id)
    result.recipe = settled(base.model_copy(update={"facts": facts, "issues": issues}))
    return result


def _picked(
    snapshot: fdc.Snapshot, canonical_id: str, fdc_id: int, edit: EditLine, now: datetime
) -> SharedMatch:
    """The editor's food and portion for the line's wording. A 422 naming the line for a food
    the FDC Snapshot doesn't have or a portion that isn't the food's.
    """
    try:
        return SharedMatch(
            wording=normalize_wording(edit.name),
            preparation=normalize_wording(edit.preparation or ""),
            canonical_id=canonical_id,
            snapshot=snapshot,
            fdc_id=fdc_id,
            portion_id=edit.portion_id,
            now=now,
        )
    except fdc.NotInSnapshot as refused:
        raise HTTPException(422, f"Line {edit.line_id}: {refused}") from None


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


def _kept(
    conversion: ConversionFact | None, line_id: str, *, keep: bool, now: datetime
) -> ConversionFact:
    """The conversion kept in the line's written unit, or converting to a weight again."""
    if conversion is None:
        raise HTTPException(422, f"Line {line_id} has no weight to keep or convert")
    if keep:
        return _by_editor(conversion, now, refused=EDITOR_KEPT)
    if conversion.density_g_per_ml is None and conversion.grams_per_count is None:
        if conversion.refused == fdc.NO_PORTION:
            raise HTTPException(
                422, f"Line {line_id} has no portion to convert it to a weight by: pick one"
            )
        raise HTTPException(422, f"Line {line_id}'s FDC portion gives nothing to convert it by")
    return _by_editor(conversion, now, refused=None)


def matched_food(recipes: list[Recipe], canonical_id: str, snapshot: fdc.Snapshot) -> int | None:
    """The FDC food of a line in the Collection matched to the Canonical Ingredient, a Confirmed
    one first, for the picker to start from after an editor chooses it. Only a food the FDC
    Snapshot has, so it can be picked.
    """
    foods = [
        (line.match.fdc_id, line.match.confirmed)
        for recipe in recipes
        for line in recipe.facts.ingredients.values()
        if line.match
        and line.match.canonical_id == canonical_id
        and snapshot.has(line.match.fdc_id)
    ]
    ordered = [fdc_id for fdc_id, confirmed in foods if confirmed] + [f for f, _ in foods]
    return next(iter(ordered), None)


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


@dataclass
class Shared:
    """What sharing a wording's match did to the other recipes with the wording."""

    updated: list[str] = field(default_factory=list[str])
    not_updated: list[str] = field(default_factory=list[str])  # kept changing: re-picking retries
    too_big: list[str] = field(default_factory=list[str])  # the match would make them too big


def share_all(store: Store, edited: Edited) -> Shared:
    """Match every other recipe's lines with the wording as the editor fixed it, each at its own
    version, after the edited recipe is saved.
    """
    shared = Shared()
    if edited.shared is None:
        return shared
    for recipe_id in edited.others:
        match _share(store, recipe_id, edited.shared):
            case "updated":
                shared.updated.append(recipe_id)
            case "not_updated":
                shared.not_updated.append(recipe_id)
            case "too_big":
                shared.too_big.append(recipe_id)
            case "gone":
                pass
    return shared


def _share(
    store: Store, recipe_id: str, shared: SharedMatch
) -> Literal["updated", "not_updated", "too_big", "gone"]:
    """Match one recipe's lines with the wording, reading it again if it changed meanwhile."""
    for _ in range(ATTEMPTS):
        current = store.get_recipe(recipe_id)
        changed = shared.apply(current) if current else None
        if changed is None:
            return "gone"  # deleted, or its line no longer has the wording
        if len(changed.model_dump_json().encode()) > MAX_RECIPE_BYTES:
            return "too_big"
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
