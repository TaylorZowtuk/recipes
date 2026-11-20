"""Our Version: the household's whole-line overlay on a recipe's Original.

An edited or added line's facts are the editor's, Confirmed, built as a Review line edit builds
them, and its text is built from its parse. An edited or added step is only its text until enrich
segments it, under the recipe's Our Version Status.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Annotated, cast

from fastapi import HTTPException
from pydantic import BaseModel, Field, StringConstraints

from recipes.edits import (
    EDITOR_KEPT,
    Edited,
    EditLine,
    ExistingCanonical,
    LineFields,
    _by_editor,  # pyright: ignore[reportPrivateUsage]
    edited_line,
)
from recipes.models import (
    MAX_LINES,
    AddedLine,
    AddedStep,
    ConversionFact,
    EnrichmentStatus,
    IngredientFacts,
    Label,
    MatchFact,
    Note,
    OurLine,
    OurLines,
    OurStep,
    OurSteps,
    OurVersion,
    Recipe,
)

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping, Sequence
    from datetime import datetime

    from recipes import fdc
    from recipes.models import ParseFact, Quantity
    from recipes.store import Store

StepText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]


class OurLineDraft(LineFields):
    """An edited line as the editor wants it, in the fields of a Review line edit."""

    component: Label | None = None


class AddedLineDraft(OurLineDraft):
    """An added line: `id` is the one Our Version gave it, or any other the draft's `after`s
    name it by until the API gives it one. `after` names the effective line it follows, or none
    for first.
    """

    id: Label | None = None
    after: Label | None


class OurStepDraft(BaseModel):
    text: StepText
    component: Label | None = None


class AddedStepDraft(OurStepDraft):
    """An added step, with `id` and `after` as an added line's."""

    id: Label | None = None
    after: Label | None


class LinesDraft(BaseModel):
    edit: Annotated[dict[str, OurLineDraft], Field(max_length=MAX_LINES)] = {}
    remove: Annotated[list[Label], Field(max_length=MAX_LINES)] = []
    add: Annotated[list[AddedLineDraft], Field(max_length=MAX_LINES)] = []


class StepsDraft(BaseModel):
    edit: Annotated[dict[str, OurStepDraft], Field(max_length=MAX_LINES)] = {}
    remove: Annotated[list[Label], Field(max_length=MAX_LINES)] = []
    add: Annotated[list[AddedStepDraft], Field(max_length=MAX_LINES)] = []


class OurVersionDraft(BaseModel):
    """Our Version as the editor wants it, whole: what it edits, removes and adds."""

    ingredients: LinesDraft = LinesDraft()
    steps: StepsDraft = StepsDraft()
    note: Note | None = None


@dataclass
class Saved:
    """The recipe with its new Our Version, and each changed line's edit, whose Canonical
    Ingredients and wordings save with it and whose match then reaches other recipes.
    """

    recipe: Recipe
    edits: list[Edited] = field(default_factory=list[Edited])


def save(
    store: Store,
    recipe: Recipe,
    draft: OurVersionDraft,
    snapshot: Callable[[], fdc.Snapshot],
    now: datetime,
) -> Saved:
    """The recipe with Our Version as drafted. A line left as it was keeps its facts; a changed
    one takes the editor's, and a Canonical Ingredient chosen for it also matches the recipe's own
    Original lines with the wording. A new or changed step makes Our Version Pending.
    Raises a 422 for a draft it can't take.
    """
    before = recipe.our_version
    lines_draft, steps_draft = draft.ingredients, draft.steps
    line_ids = [line.id for line in recipe.original.ingredients]
    step_ids = [step.id for step in recipe.original.steps]
    _check_changes("Line", "line", line_ids, lines_draft.edit, lines_draft.remove)
    _check_changes("Step", "step", step_ids, steps_draft.edit, steps_draft.remove)
    stored_lines = before.ingredients if before else OurLines()
    stored_steps = before.steps if before else OurSteps()
    added_lines = _ids("i", "Line", line_ids, [a.id for a in stored_lines.add], lines_draft.add)
    added_steps = _ids("s", "Step", step_ids, [a.id for a in stored_steps.add], steps_draft.add)
    _check_order("Line", line_ids, lines_draft.remove, added_lines)
    _check_order("Step", step_ids, steps_draft.remove, added_steps)

    saved = Saved(recipe)
    originals = recipe.facts.ingredients
    edit = {
        line_id: _line(
            line_id,
            line,
            stored_lines.edit.get(line_id),
            originals.get(line_id),
            store=store,
            saved=saved,
            snapshot=snapshot,
            now=now,
        )
        for line_id, line in lines_draft.edit.items()
    }
    previous = {added.id: added for added in stored_lines.add}
    add = [
        AddedLine(
            id=line_id,
            after=after,
            **_line(
                line_id,
                line,
                previous.get(line_id),
                None,
                store=store,
                saved=saved,
                snapshot=snapshot,
                now=now,
            ).model_dump(include=set(OurLine.model_fields)),
        )
        for line_id, after, line in added_lines
    ]
    steps = OurSteps(
        edit={
            step_id: OurStep(text=s.text, component=s.component)
            for step_id, s in steps_draft.edit.items()
        },
        remove=steps_draft.remove,
        add=[
            AddedStep(id=i, after=after, text=s.text, component=s.component)
            for i, after, s in added_steps
        ],
    )
    ours = OurVersion(
        ingredients=OurLines(edit=edit, remove=lines_draft.remove, add=add),
        steps=steps,
        note=draft.note,
        edited_at=now,
    )
    status = _status(recipe, stored_steps, steps)
    changed = recipe.model_copy(update={"our_version": ours, "our_version_status": status})
    for edited in saved.edits:
        if edited.shared:
            changed = edited.shared.apply(changed) or changed
    saved.recipe = changed
    return saved


def _check_changes(
    kind: str, noun: str, original: list[str], edit: Mapping[str, object], removed: list[str]
) -> None:
    """A 422 unless Our Version edits and removes only the Original's lines or steps, each once."""
    ids = set(original)
    for item_id in [*edit, *removed]:
        if item_id not in ids:
            raise HTTPException(422, f"The recipe has no {noun} {item_id}")
    for item_id in set(edit) & set(removed):
        raise HTTPException(422, f"{kind} {item_id} is both edited and removed")
    if len(set(removed)) < len(removed):
        raise HTTPException(422, f"{kind}s are removed once each")


def _ids[A: AddedLineDraft | AddedStepDraft](
    prefix: str, kind: str, original: list[str], stored: list[str], added: list[A]
) -> list[tuple[str, str | None, A]]:
    """Each added line's or step's id and the id it follows. It keeps an id Our Version already
    gave it; any other gets the next in the sequence past every id the Original and Our Version
    used, and the draft's `after`s that named it name that id.
    """
    given = [a.id for a in added if a.id is not None]
    for item_id in given:
        if item_id in original:
            raise HTTPException(422, f"{kind} {item_id} is the Original's, so it can't be added")
        if given.count(item_id) > 1:
            raise HTTPException(422, f"{kind} {item_id} is added twice")
    used = [int(m[1]) for i in [*original, *stored] if (m := re.fullmatch(rf"{prefix}(\d+)", i))]
    following = max(used, default=0)
    renamed: dict[str, str] = {}
    ids: list[str] = []
    for a in added:
        if a.id is not None and a.id in stored:
            ids.append(a.id)
            continue
        following += 1
        ids.append(f"{prefix}{following}")
        if a.id is not None:
            renamed[a.id] = ids[-1]
    return [
        (item_id, renamed.get(a.after, a.after) if a.after else None, a)
        for item_id, a in zip(ids, added, strict=True)
    ]


def _check_order(
    kind: str,
    original: list[str],
    removed: list[str],
    added: Sequence[tuple[str, str | None, object]],
) -> None:
    """A 422 unless each added line or step follows one in the effective list, or is first."""
    placed = set(original) - set(removed)
    waiting = list(added)
    while waiting:
        ready = [a for a in waiting if a[1] is None or a[1] in placed]
        if not ready:
            item_id, after, _ = waiting[0]
            raise HTTPException(
                422, f"{kind} {item_id} follows {after}, which isn't in Our Version"
            )
        placed |= {item_id for item_id, _, _ in ready}
        waiting = [a for a in waiting if a not in ready]


def _line(
    line_id: str,
    draft: OurLineDraft,
    stored: OurLine | None,
    original: IngredientFacts | None,
    *,
    store: Store,
    saved: Saved,
    snapshot: Callable[[], fdc.Snapshot],
    now: datetime,
) -> OurLine:
    """The Our Version line as drafted: as stored if nothing but its component changed, else with
    the editor's facts, built from the line it replaces as a Review line edit builds them. A line
    Our Version adds needs a Canonical Ingredient.
    """
    if stored and _unchanged(draft, stored):
        return stored.model_copy(update={"component": draft.component})
    old = (
        IngredientFacts(parse=stored.parse, match=stored.match, conversion=stored.conversion)
        if stored
        else original
    )
    if draft.canonical is None and (old is None or old.match is None) and original is None:
        raise HTTPException(422, f"Line {line_id} needs a Canonical Ingredient choice")
    fields = {name: getattr(draft, name) for name in LineFields.model_fields}
    edit = EditLine(kind="line", line_id=line_id, **fields)
    edited = Edited(saved.recipe)
    facts = edited_line(
        store, saved.recipe.id, edit, old, snapshot=snapshot, now=now, result=edited
    )
    saved.edits.append(edited)
    parse = cast("ParseFact", facts.parse)  # an edit always gives the line a parse
    return OurLine(
        text=line_text(parse),
        component=draft.component,
        parse=parse,
        match=_as_editors(facts.match, now),
        conversion=_as_editors(facts.conversion, now),
    )


def _as_editors[F: (MatchFact, ConversionFact)](fact: F | None, now: datetime) -> F | None:
    """The fact as the editor's: a match or conversion kept from the Original was enrichment's."""
    return fact if fact is None or fact.provenance == "editor" else _by_editor(fact, now)


def _unchanged(draft: OurLineDraft, stored: OurLine) -> bool:
    """Whether the draft is the stored line: its fields, food and Canonical Ingredient, and its
    weight kept or converted as it is.
    """
    parse, match, conversion = stored.parse, stored.match, stored.conversion
    canonical = draft.canonical
    same_canonical = canonical is None or (
        isinstance(canonical, ExistingCanonical)
        and match is not None
        and canonical.id == match.canonical_id
    )
    kept = conversion is not None and conversion.refused == EDITOR_KEPT
    food = (match.fdc_id, match.portion_id) if match else (None, None)
    return (
        same_canonical
        and (draft.quantity, draft.unit, draft.name, draft.preparation)
        == (parse.quantity, parse.unit, parse.name, parse.preparation)
        and (draft.fdc_id, draft.portion_id) == food
        and draft.keep_weight in (None, kept)
    )


def _status(recipe: Recipe, stored: OurSteps, steps: OurSteps) -> EnrichmentStatus:
    """Pending when a step is new or its text changed, else as it was, or Ready for a new Our
    Version.
    """
    before = {**{i: s.text for i, s in stored.edit.items()}, **{a.id: a.text for a in stored.add}}
    after = {**{i: s.text for i, s in steps.edit.items()}, **{a.id: a.text for a in steps.add}}
    if any(before.get(step_id) != text for step_id, text in after.items()):
        return "pending"
    return recipe.our_version_status or "ready"


# The kitchen fractions a recipe shows, as the PWA's amount formatter has them.
FRACTIONS = [
    (1 / 8, "⅛"),
    (1 / 4, "¼"),
    (1 / 3, "⅓"),
    (3 / 8, "⅜"),
    (1 / 2, "½"),
    (5 / 8, "⅝"),
    (2 / 3, "⅔"),
    (3 / 4, "¾"),
    (7 / 8, "⅞"),
]


def kitchen_number(value: float) -> str:
    """A number as the PWA shows it: a kitchen fraction where one fits, else a decimal of at most
    two places.
    """
    whole = math.floor(value)
    rest = value - whole
    if rest < 0.01:  # noqa: PLR2004 - the PWA's tolerance
        return str(whole)
    glyph = next((glyph for part, glyph in FRACTIONS if abs(rest - part) < 0.01), None)  # noqa: PLR2004
    if glyph:
        return f"{whole or ''}{glyph}"
    rounded = math.floor(value * 100 + 0.5) / 100
    return str(int(rounded)) if rounded.is_integer() else str(rounded)


def format_amount(quantity: Quantity, unit: str | None) -> str:
    """An amount as the PWA shows it, with an en dash between a range's ends; of the units only
    "cup" takes a plural.
    """
    low, high = kitchen_number(quantity.low), kitchen_number(quantity.high)
    shown = "cups" if unit == "cup" and quantity.high > 1 else unit
    number = low if quantity.low == quantity.high else f"{low}\N{EN DASH}{high}"
    return " ".join(part for part in (number, shown) if part)


def line_text(parse: ParseFact) -> str:
    """A line's text as the recipe view shows its parse: "2 can diced tomatoes, drained"."""
    amount = format_amount(parse.quantity, parse.unit) if parse.quantity else parse.unit
    remarks = [remark for remark in (parse.preparation, parse.comment) if remark]
    return ", ".join([" ".join(part for part in (amount, parse.name) if part), *remarks])
