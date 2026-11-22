"""Our Version: the household's whole-line overlay on a recipe's Original.

An edited or added line's facts are the editor's, Confirmed, built as a Review line edit builds
them, and its text is built from its parse. An edited or added step is only its text until enrich
segments it, under the recipe's Our Version Status.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from functools import cache
from typing import TYPE_CHECKING, Annotated, Literal, NoReturn, cast

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
    MAX_RECIPE_BYTES,
    OUR_VERSION,
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
    RecipeFacts,
    item_of,
    resolve,
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
    Original lines with the wording. A new or changed step makes Our Version Pending, and one
    Awaiting Review whose last open issue the save settles is Ready.
    Raises a 422 for a draft it can't take.
    """
    if len(draft.model_dump_json().encode()) > MAX_RECIPE_BYTES:
        # Too big for the recipe to hold, so refused before its lines reach the store.
        raise HTTPException(422, f"An edited recipe is at most {MAX_RECIPE_BYTES} bytes as JSON")
    before = recipe.our_version
    lines_draft, steps_draft = draft.ingredients, draft.steps
    line_ids = [line.id for line in recipe.original.ingredients]
    step_ids = [step.id for step in recipe.original.steps]
    _check_changes("ingredients", line_ids, lines_draft.edit, lines_draft.remove)
    _check_changes("steps", step_ids, steps_draft.edit, steps_draft.remove)
    stored_lines = before.ingredients if before else OurLines()
    stored_steps = before.steps if before else OurSteps()
    added_lines, last_line = _ids(
        "ingredients",
        line_ids,
        [a.id for a in stored_lines.add],
        lines_draft.add,
        before.last_line if before else 0,
    )
    added_steps, last_step = _ids(
        "steps",
        step_ids,
        [a.id for a in stored_steps.add],
        steps_draft.add,
        before.last_step if before else 0,
    )
    _check_order("ingredients", line_ids, lines_draft.remove, added_lines)
    _check_order("steps", step_ids, steps_draft.remove, added_steps)

    saved = Saved(recipe)
    collection = cache(store.recipes)  # read once, for every line whose wording a pick fixes
    stored_facts = before.facts.ingredients if before else {}
    originals = recipe.facts.ingredients
    drafted = [
        *((line_id, line, originals.get(line_id)) for line_id, line in lines_draft.edit.items()),
        *((line_id, line, None) for line_id, _, line in added_lines),
    ]
    # A refusal names an added line by the id the draft gave it, if it gave one.
    named = {line_id: line.id or line_id for line_id, _, line in added_lines}
    built = {
        line_id: _line(
            named.get(line_id, line_id),
            line,
            stored_facts.get(line_id),
            original,
            store=store,
            saved=saved,
            snapshot=snapshot,
            recipes=collection,
            now=now,
        )
        for line_id, line, original in drafted
    }
    fresh = {line_id: facts for line_id, facts in built.items() if facts is not None}
    kept = {line_id: stored_facts[line_id] for line_id, facts in built.items() if facts is None}
    # A line Our Version writes always has a parse, as an edit gives one.
    texts = {
        line_id: line_text(cast("ParseFact", facts.parse))
        for line_id, facts in {**kept, **fresh}.items()
    }
    edit = {
        line_id: OurLine(text=texts[line_id], component=line.component)
        for line_id, line in lines_draft.edit.items()
    }
    add = [
        AddedLine(id=line_id, after=after, text=texts[line_id], component=line.component)
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
        facts=RecipeFacts(ingredients=kept),
        note=draft.note,
        edited_at=now,
        last_line=last_line,
        last_step=last_step,
    )
    status = _status(recipe, stored_steps, steps)
    changed = recipe.model_copy(update={"our_version": ours, "our_version_status": status})
    for edited in saved.edits:
        if edited.shared:
            changed = edited.shared.apply(changed) or changed
    # The lines this save changed are the editor's own picks, so the spread passes them by, and
    # their open issues, with those of lines it dropped, are settled.
    ours = cast("OurVersion", changed.our_version)
    spread = ours.facts.ingredients
    facts = {line_id: fresh[line_id] if line_id in fresh else spread[line_id] for line_id in built}
    issues = resolve(
        changed,
        lambda fact_id: (
            fact_id.startswith(OUR_VERSION)
            and item_of(fact_id.removeprefix(OUR_VERSION)) not in kept
        ),
    )
    ours = ours.model_copy(update={"facts": ours.facts.model_copy(update={"ingredients": facts})})
    # Awaiting Review with no open issue on Our Version left, it has nothing to check.
    status = changed.our_version_status
    left = any(i.status == "open" and i.fact_id.startswith(OUR_VERSION) for i in issues)
    if status == "awaiting_review" and not left:
        status = "ready"
    saved.recipe = changed.model_copy(
        update={"our_version": ours, "issues": issues, "our_version_status": status}
    )
    return saved


Part = Literal["ingredients", "steps"]
KIND: dict[Part, str] = {"ingredients": "Line", "steps": "Step"}
PREFIX: dict[Part, str] = {"ingredients": "i", "steps": "s"}


def refuse(part: Part, item_id: str, message: str) -> NoReturn:
    """A 422 naming the draft's line or step by the id the draft gave it, so the PWA can show it
    at that line or step: `[{"msg", "part", "id"}]`, as a validation error's `msg` reads.
    """
    raise HTTPException(422, [{"msg": message, "part": part, "id": item_id}])


def _check_changes(
    part: Part, original: list[str], edit: Mapping[str, object], removed: list[str]
) -> None:
    """A 422 unless Our Version edits and removes only the Original's lines or steps, each once."""
    kind = KIND[part]
    ids = set(original)
    for item_id in [*edit, *removed]:
        if item_id not in ids:
            refuse(part, item_id, f"The recipe has no {kind.lower()} {item_id}")
    for item_id in set(edit) & set(removed):
        refuse(part, item_id, f"{kind} {item_id} is both edited and removed")
    for item_id in removed:
        if removed.count(item_id) > 1:
            refuse(part, item_id, f"{kind}s are removed once each")


def _ids[A: AddedLineDraft | AddedStepDraft](
    part: Part, original: list[str], stored: list[str], added: list[A], last: int
) -> tuple[list[tuple[str, str | None, A]], int]:
    """Each added line's or step's id and the id it follows, and the highest number given. It
    keeps an id Our Version already gave it; any other gets the next in the sequence past every
    id the Original used and every number Our Version gave (`last`), and the draft's `after`s
    that named it name that id.
    """
    kind, prefix = KIND[part], PREFIX[part]
    given = [a.id for a in added if a.id is not None]
    for item_id in given:
        if item_id in original:
            refuse(part, item_id, f"{kind} {item_id} is the Original's, so it can't be added")
        if given.count(item_id) > 1:
            refuse(part, item_id, f"{kind} {item_id} is added twice")
    used = [int(m[1]) for i in [*original, *stored] if (m := re.fullmatch(rf"{prefix}(\d+)", i))]
    following = max([*used, last])
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
    placed = [
        (item_id, renamed.get(a.after, a.after) if a.after else None, a)
        for item_id, a in zip(ids, added, strict=True)
    ]
    return placed, following


def _check_order(
    part: Part,
    original: list[str],
    removed: list[str],
    added: Sequence[tuple[str, str | None, AddedLineDraft | AddedStepDraft]],
) -> None:
    """A 422 unless each added line or step follows one in the effective list, or is first."""
    placed = set(original) - set(removed)
    waiting = list(added)
    while waiting:
        ready = [a for a in waiting if a[1] is None or a[1] in placed]
        if not ready:
            item_id, _, draft = waiting[0]
            item_id = draft.id or item_id
            refuse(
                part,
                item_id,
                f"{KIND[part]} {item_id} follows {draft.after}, which isn't in Our Version",
            )
        placed |= {item_id for item_id, _, _ in ready}
        waiting = [a for a in waiting if a not in ready]


def _line(
    line_id: str,
    draft: OurLineDraft,
    stored: IngredientFacts | None,
    original: IngredientFacts | None,
    *,
    store: Store,
    saved: Saved,
    snapshot: Callable[[], fdc.Snapshot],
    recipes: Callable[[], list[Recipe]],
    now: datetime,
) -> IngredientFacts | None:
    """The Our Version line's facts as drafted: None if they stay as stored, since only its
    component changed, else the editor's, built from the line it replaces as a Review line edit
    builds them. A line Our Version adds needs a Canonical Ingredient.
    """
    if stored and _unchanged(draft, stored):
        return None
    # The Original's substitutes are for its own line, not the one Our Version writes.
    old = stored or (original.model_copy(update={"substitutions": None}) if original else None)
    if draft.canonical is None and (old is None or old.match is None) and original is None:
        refuse("ingredients", line_id, f"Line {line_id} needs a Canonical Ingredient choice")
    # A Review line edit's refusal names the line by the draft's id, for the PWA to show it there.
    try:
        fields = {name: getattr(draft, name) for name in LineFields.model_fields}
        edit = EditLine(kind="line", line_id=line_id, **fields)
        edited = Edited(saved.recipe)
        facts = edited_line(
            store,
            saved.recipe.id,
            edit,
            old,
            snapshot=snapshot,
            recipes=recipes,
            now=now,
            result=edited,
        )
        saved.edits.append(edited)
        return facts.model_copy(
            update={
                "match": _as_editors(facts.match, now),
                "conversion": _as_editors(facts.conversion, now),
            }
        )
    except HTTPException as refusal:
        refuse("ingredients", line_id, refusal.detail)


def _as_editors[F: (MatchFact, ConversionFact)](fact: F | None, now: datetime) -> F | None:
    """The fact as the editor's: a match or conversion kept from the Original was enrichment's."""
    return fact if fact is None or fact.provenance == "editor" else _by_editor(fact, now)


def _unchanged(draft: OurLineDraft, stored: IngredientFacts) -> bool:
    """Whether the draft is the stored line: its fields, food and Canonical Ingredient, and its
    weight kept or converted as it is.
    """
    parse, match, conversion = stored.parse, stored.match, stored.conversion
    if parse is None:
        return False
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
