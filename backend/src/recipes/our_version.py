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
    CanonicalChoice,
    Edited,
    EditLine,
    ExistingCanonical,
    LineFields,
    by_editor,
    chosen_canonical,
    edited_line,
    new_by_editor,
    substitute_numbers,
)
from recipes.models import (
    MAX_LINES,
    MAX_RECIPE_BYTES,
    MAX_SUBSTITUTES,
    OUR_VERSION,
    PORTION_TOLERANCE,
    AddedLine,
    AddedStep,
    ConversionFact,
    Effective,
    EnrichmentIssue,
    EnrichmentStatus,
    IngredientFacts,
    IngredientSegment,
    Label,
    MatchFact,
    Note,
    OurLine,
    OurLines,
    OurStep,
    OurSteps,
    OurVersion,
    Ratio,
    Recipe,
    RecipeFacts,
    Segment,
    StepFacts,
    StepUse,
    Substitution,
    SubstitutionsFact,
    TextSegment,
    effective,
    item_of,
    normalize_wording,
    our_version_settled,
    resolve,
)
from recipes.step_portions import (
    flag_overused,
    flagged,
    line_name,
    refs,
    step_issue,
    steps_use,
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


class SubstituteDraft(BaseModel):
    """A household substitute for a line: its Canonical Ingredient, existing or new, its wording
    (none for the Canonical Ingredient's name), how much of it to use, a note, and its FDC food
    and FDC portion, whose numbers the API copies from the FDC Snapshot.
    """

    canonical: CanonicalChoice
    wording: Label | None = None
    ratio: Ratio
    note: Label
    fdc_id: int
    portion_id: int | None


class LinesDraft(BaseModel):
    """The lines Our Version edits, removes and adds, and each line's household substitutions,
    by the Original's line id or an added line's draft id: a line left out shows the Original's
    substitutions, and an empty list shows none.
    """

    edit: Annotated[dict[str, OurLineDraft], Field(max_length=MAX_LINES)] = {}
    remove: Annotated[list[Label], Field(max_length=MAX_LINES)] = []
    add: Annotated[list[AddedLineDraft], Field(max_length=MAX_LINES)] = []
    substitutions: Annotated[
        dict[str, Annotated[list[SubstituteDraft], Field(max_length=MAX_SUBSTITUTES)]],
        Field(max_length=MAX_LINES),
    ] = {}


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
    Original lines with the wording. A line's household substitutions are the editor's, kept as
    stored while they stay as they were, and never mark the line changed. A new or changed step
    makes Our Version Pending, and one Awaiting Review whose last open issue the save settles is
    Ready. A step the save leaves with a Segment or use for a line it removed, or renamed or
    matched anew, is flagged.
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
        recipe.our_version_last_line,
    )
    added_steps, last_step = _ids(
        "steps",
        step_ids,
        [a.id for a in stored_steps.add],
        steps_draft.add,
        recipe.our_version_last_step,
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
    effective_ids = {
        **{i: i for i in line_ids if i not in lines_draft.remove},
        **{name: line_id for line_id, name in named.items()},
    }
    swaps = _household(
        lines_draft.substitutions,
        effective_ids,
        lines_draft.remove,
        {**originals, **kept, **fresh},
        stored_facts,
        store=store,
        saved=saved,
        snapshot=snapshot,
        now=now,
    )
    fresh = {i: f.model_copy(update={"substitutions": swaps.get(i)}) for i, f in fresh.items()}
    kept = {i: f.model_copy(update={"substitutions": swaps.get(i)}) for i, f in kept.items()}
    # A line otherwise as the Original has it holds only its substitutions.
    held = {i: IngredientFacts(substitutions=f) for i, f in swaps.items() if i not in built}
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
    before_steps, after_steps = _texts(stored_steps), _texts(steps)
    # A step keeps the facts enrich gave it while its text stays as it was.
    stored_step_facts = before.facts.steps if before else {}
    kept_steps = {
        step_id: facts
        for step_id, facts in stored_step_facts.items()
        if step_id in after_steps and before_steps.get(step_id) == after_steps[step_id]
    }
    ours = OurVersion(
        ingredients=OurLines(edit=edit, remove=lines_draft.remove, add=add),
        steps=steps,
        facts=RecipeFacts(ingredients={**kept, **held}, steps=kept_steps),
        note=draft.note,
        edited_at=now,
    )
    status = _status(recipe, stored_steps, steps, kept_steps)
    ready_batch = recipe.our_version_ready_batch
    changed = recipe.model_copy(
        update={
            "our_version": ours,
            "our_version_status": status,
            "our_version_ready_batch": ready_batch if status == "ready" else None,
            "our_version_last_line": last_line,
            "our_version_last_step": last_step,
        }
    )
    stored_swaps = {
        i: f.substitutions for i, f in stored_facts.items() if f.substitutions is not None
    }
    touched = {
        *fresh,
        *(i for i, facts in stored_facts.items() if facts.parse and i not in built),
        *(
            f"{i}.substitutions"
            for i in {*stored_swaps, *swaps}
            if stored_swaps.get(i) != swaps.get(i)
        ),
        *(i for i, text in before_steps.items() if after_steps.get(i) != text),
        *(i for i, text in after_steps.items() if before_steps.get(i) != text),
    }
    saved.recipe = _finished(recipe, changed, saved.edits, fresh, touched)
    return saved


def edit_line(
    store: Store,
    recipe: Recipe,
    edit: EditLine,
    snapshot: Callable[[], fdc.Snapshot],
    now: datetime,
) -> Edited:
    """The recipe with a Review edit of one Our Version line, `edit.line_id` being its Review
    Item (`our_version.i3`): its facts built and settled as an Our Version save that changes only
    that line builds and settles them, and its text built from its parse. The Original's facts
    change only where the line's pick fixes a wording. A 422 for a line Our Version doesn't write.
    """
    line_id = edit.line_id.removeprefix(OUR_VERSION)
    ours = recipe.our_version
    stored = ours.facts.ingredients.get(line_id) if ours else None
    written: set[str] = set()
    if ours:
        written = {*ours.ingredients.edit, *(a.id for a in ours.ingredients.add)}
    # A line holding only household substitutions isn't one Our Version writes.
    if ours is None or stored is None or line_id not in written:
        raise HTTPException(422, f"Our Version has no line {line_id}")
    result = Edited(recipe)
    facts = _built(
        line_id,
        edit,
        stored,
        store=store,
        result=result,
        snapshot=snapshot,
        recipes=store.recipes,
        now=now,
    )
    text = line_text(cast("ParseFact", facts.parse))
    lines = ours.ingredients
    if line_id in lines.edit:
        edited = {**lines.edit, line_id: lines.edit[line_id].model_copy(update={"text": text})}
        lines = lines.model_copy(update={"edit": edited})
    else:
        added = [a.model_copy(update={"text": text}) if a.id == line_id else a for a in lines.add]
        lines = lines.model_copy(update={"add": added})
    ours = ours.model_copy(
        update={
            "ingredients": lines,
            "facts": ours.facts.model_copy(
                update={"ingredients": {**ours.facts.ingredients, line_id: facts}}
            ),
            "edited_at": now,
        }
    )
    changed = recipe.model_copy(update={"our_version": ours})
    result.recipe = _finished(recipe, changed, [result], {line_id: facts}, {line_id})
    return result


def _finished(
    before: Recipe,
    changed: Recipe,
    edits: Sequence[Edited],
    fresh: Mapping[str, IngredientFacts],
    touched: set[str],
) -> Recipe:
    """The recipe an Our Version change leaves, with the lines it rebuilt (`fresh`): each line's
    pick spread over the recipe, apart from those lines, which are the editor's own picks; the
    open issues of the lines and steps it `touched`, and of the facts it touched such as
    `i3.substitutions`, settled, the rest kept; each step it affected flagged, as is each that
    now uses a line past all of it, while a flag whose line is back within all of it is settled;
    and its Our Version settled.
    """
    for edited in edits:
        if edited.shared:
            changed = edited.shared.apply(changed) or changed
    ours = cast("OurVersion", changed.our_version)
    facts = {**ours.facts.ingredients, **fresh}
    issues = resolve(
        changed,
        lambda fact_id: (
            fact_id.startswith(OUR_VERSION)
            and (
                (path := fact_id.removeprefix(OUR_VERSION)) in touched
                or path.partition(".")[0] in touched
            )
        ),
    )
    ours = ours.model_copy(update={"facts": ours.facts.model_copy(update={"ingredients": facts})})
    done = changed.model_copy(update={"our_version": ours, "issues": issues})
    return our_version_settled(flag_overused(flagged(done, _affected(before, done, set(fresh)))))


def _affected(before: Recipe, after: Recipe, fresh: set[str]) -> list[EnrichmentIssue]:
    """An issue for each step of `after` with a Segment or use for a line the save removed, or
    rebuilt (`fresh`) with another name or Canonical Ingredient. Amounts, units and preparations
    don't affect a step, nor does a wording spread to a line the save left alone.
    """
    was, now = effective(before), effective(after)
    ours = cast("OurVersion", after.our_version)
    kept = {line.id for line in now.ingredients}
    changed = {
        line_id: "removed" if line_id not in kept else "changed"
        for line_id in (line.id for line in was.ingredients)
        if line_id not in kept
        or (line_id in fresh and _identity(was, line_id) != _identity(now, line_id))
    }
    steps = [
        (step.id, (ours.facts.steps if step.change else after.facts.steps).get(step.id))
        for step in now.steps
    ]
    return _mentioning(steps, changed, was)


def reenriched(before: Recipe, after: Recipe) -> Recipe:
    """The re-enriched recipe `after` with the open issues of the unchanged steps whose facts the
    re-enrichment replaced settled, and an issue on each of those with a Segment or use for a line
    Our Version removed, or edited to another name or Canonical Ingredient than the Original's.
    """
    ours = after.our_version
    if ours is None:
        return after
    now = effective(after)
    replaced = [
        step.id
        for step in now.steps
        if not step.change and before.facts.steps.get(step.id) != after.facts.steps.get(step.id)
    ]
    issues = resolve(
        after,
        lambda fact_id: (
            fact_id.startswith(OUR_VERSION)
            and item_of(fact_id).removeprefix(OUR_VERSION) in replaced
        ),
    )
    original = effective(after.model_copy(update={"our_version": None}))
    changed = dict.fromkeys(ours.ingredients.remove, "removed") | {
        line_id: "changed"
        for line_id in ours.ingredients.edit
        if _identity(original, line_id) != _identity(now, line_id)
    }
    steps = [(step_id, after.facts.steps.get(step_id)) for step_id in replaced]
    settled = after.model_copy(update={"issues": issues})
    return our_version_settled(flagged(settled, _mentioning(steps, changed, original)))


def _mentioning(
    steps: Sequence[tuple[str, StepFacts | None]], changed: Mapping[str, str], names: Effective
) -> list[EnrichmentIssue]:
    """An issue, settled by confirming the step as it is, on each step whose facts have a Segment
    or use for a line in `changed`, saying how Our Version changed it, named as `names` has it.
    """
    return [
        step_issue(
            step_id,
            f"Mentions {line_name(names, ref)}, which Our Version {how}",
            settles_on_confirm=True,
        )
        for step_id, facts in steps
        for ref, how in changed.items()
        if ref in refs(facts)
    ]


def _identity(shown: Effective, line_id: str) -> tuple[str | None, str | None]:
    """What a step names a line by: its name and Canonical Ingredient."""
    facts = shown.facts.ingredients.get(line_id)
    parse, match = (facts.parse, facts.match) if facts else (None, None)
    return (
        normalize_wording(parse.name) if parse else None,
        match.canonical_id if match else None,
    )


def capped(
    recipe: Recipe, answers: Mapping[str, StepFacts]
) -> tuple[dict[str, StepFacts], list[EnrichmentIssue]]:
    """Enrich's answers for Our Version's steps, in the effective order, each Segment at most what
    the other effective steps leave of its line: one past that is stored at what's left, or as its
    text when none is, with an issue naming the other steps that use the line, which confirming
    the step as it is settles.
    """
    shown = effective(recipe)
    used: dict[str, float] = {}
    for step_id, facts in shown.facts.steps.items():
        for use in facts.uses.uses if facts.uses and step_id not in answers else []:
            used[use.ref] = used.get(use.ref, 0) + use.portion
    order = [step.id for step in shown.steps]
    stored: dict[str, StepFacts] = {}
    short: dict[str, set[str]] = {}
    for step_id in sorted(answers, key=order.index):
        stored[step_id], short[step_id] = _capped(answers[step_id], used)
    steps = {**shown.facts.steps, **stored}
    issues: list[EnrichmentIssue] = []
    for step_id, lines in short.items():
        for ref in sorted(lines):
            others = {i for i, facts in steps.items() if i != step_id and ref in refs(facts)}
            left = "what's left of it" if ref in refs(stored[step_id]) else "none of it"
            reason = f"{steps_use(shown, others)} {line_name(shown, ref)} too, so this step has"
            issues.append(step_issue(step_id, f"{reason} {left}", settles_on_confirm=True))
    return stored, issues


def _capped(facts: StepFacts, used: dict[str, float]) -> tuple[StepFacts, set[str]]:
    """The step's facts with each ingredient Segment at most what `used` leaves of its line, and
    the lines it had too much of. `used` gains what the step takes.
    """
    short: set[str] = set()

    def took(segment: Segment) -> Segment:
        if not isinstance(segment, IngredientSegment):
            return segment
        room = 1 - used.get(segment.ref, 0)
        portion = segment.portion
        if portion > room + PORTION_TOLERANCE:
            short.add(segment.ref)
            portion = room if room > PORTION_TOLERANCE else 0
        used[segment.ref] = used.get(segment.ref, 0) + portion
        if not portion:
            return TextSegment(v=segment.written)
        return segment.model_copy(update={"portion": portion})

    if facts.segments is None:
        return facts, short
    segments = [took(segment) for segment in facts.segments.segments]
    summed: dict[str, float] = {}
    for segment in segments:
        if isinstance(segment, IngredientSegment):
            summed[segment.ref] = summed.get(segment.ref, 0) + segment.portion
    uses = [StepUse(ref=ref, portion=portion) for ref, portion in summed.items()]
    return StepFacts(
        segments=facts.segments.model_copy(update={"segments": segments}),
        uses=facts.uses.model_copy(update={"uses": uses}) if facts.uses else None,
    ), short


Part = Literal["ingredients", "steps"]
KIND: dict[Part, str] = {"ingredients": "Line", "steps": "Step"}
PREFIX: dict[Part, str] = {"ingredients": "i", "steps": "s"}


class RefusedAt(BaseModel):
    """An Our Version line or step the API refused, by the id the draft gave it, and why."""

    msg: str
    part: Part
    id: str


class InvalidField(BaseModel):
    """One of FastAPI's validation errors."""

    loc: list[str | int]
    msg: str
    type: str


class Refused(BaseModel):
    """A 422: why the API refused the edit, as a message, as FastAPI's validation errors, or as
    the one Our Version line or step it refused, for the PWA to show it there.
    """

    detail: str | list[RefusedAt] | list[InvalidField]


def refuse(part: Part, item_id: str, message: str) -> NoReturn:
    """A 422 naming the draft's line or step by the id the draft gave it, so the PWA can show it
    at that line or step.
    """
    raise HTTPException(422, [RefusedAt(msg=message, part=part, id=item_id).model_dump()])


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
    id the Original used and every number any Our Version gave (`last`), and the draft's `after`s
    that named it name that id.
    """
    kind, prefix = KIND[part], PREFIX[part]
    given = [a.id for a in added if a.id is not None]
    for item_id in given:
        if item_id in original:
            refuse(part, item_id, f"{kind} {item_id} is the Original's, so it can't be added")
        if given.count(item_id) > 1:
            refuse(part, item_id, f"{kind} {item_id} is added twice")
    following = max(_highest(part, [*original, *stored]), last)
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


def _highest(part: Part, ids: Sequence[str]) -> int:
    """The highest number among the ids of the part's sequence (`i3`, `s2`), or 0."""
    prefix = PREFIX[part]
    return max([int(m[1]) for i in ids if (m := re.fullmatch(rf"{prefix}(\d+)", i))], default=0)


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
    if stored and stored.parse is None:
        # A line holding only household substitutions is built from the Original's, as a first
        # edit is; its substitutions come from the draft.
        stored = None
    if stored and _unchanged(draft, stored):
        return None
    # The Original's substitutes are for its own line, not the one Our Version writes.
    old = stored or (original.model_copy(update={"substitutions": None}) if original else None)
    if draft.canonical is None and (old is None or old.match is None) and original is None:
        refuse("ingredients", line_id, f"Line {line_id} needs a Canonical Ingredient choice")
    # A Review line edit's refusal names the line by the draft's id, for the PWA to show it there.
    try:
        edited = Edited(saved.recipe)
        facts = _built(
            line_id,
            draft,
            old,
            store=store,
            result=edited,
            snapshot=snapshot,
            recipes=recipes,
            now=now,
        )
    except HTTPException as refusal:
        refuse("ingredients", line_id, refusal.detail)
    saved.edits.append(edited)
    return facts


def _household(
    drafted: Mapping[str, list[SubstituteDraft]],
    effective_ids: Mapping[str, str],
    removed: list[str],
    lines: Mapping[str, IngredientFacts],
    stored: Mapping[str, IngredientFacts],
    *,
    store: Store,
    saved: Saved,
    snapshot: Callable[[], fdc.Snapshot],
    now: datetime,
) -> dict[str, SubstitutionsFact]:
    """Each effective line's household substitutions as drafted, by its id (`effective_ids` maps
    the draft's id to it), refusing one on a line not in Our Version or its own Canonical
    Ingredient (its `lines` match). Ones as stored keep their facts; others are the editor's.
    """
    swaps: dict[str, SubstitutionsFact] = {}
    for name, drafts in drafted.items():
        if name in removed:
            refuse("ingredients", name, f"Line {name} is removed, so it holds no substitutions")
        line_id = effective_ids.get(name)
        if line_id is None:
            refuse("ingredients", name, f"The recipe has no line {name}")
        match = lines[line_id].match if line_id in lines else None
        own = match.canonical_id if match else None
        if any(
            isinstance(d.canonical, ExistingCanonical) and d.canonical.id == own for d in drafts
        ):
            refuse("ingredients", name, "A substitute isn't its line's own Canonical Ingredient")
        before = stored[line_id].substitutions if line_id in stored else None
        if before is not None and _same_substitutes(store, drafts, before.items):
            swaps[line_id] = before
            continue
        items = [_substitute(store, name, d, saved=saved, snapshot=snapshot) for d in drafts]
        swaps[line_id] = new_by_editor(SubstitutionsFact, now, items=items)
    return swaps


def _same_substitutes(
    store: Store, drafts: list[SubstituteDraft], items: list[Substitution]
) -> bool:
    """Whether the drafted substitutes are the stored ones, in order, a draft with no wording
    taking its Canonical Ingredient's name.
    """

    def same(draft: SubstituteDraft, item: Substitution) -> bool:
        canonical = draft.canonical
        if not isinstance(canonical, ExistingCanonical) or canonical.id != item.canonical_id:
            return False
        fields = (draft.ratio, draft.note, draft.fdc_id, draft.portion_id)
        if fields != (item.ratio, item.note, item.fdc_id, item.portion_id):
            return False
        if draft.wording is not None:
            return draft.wording == item.wording
        found = store.canonical_ingredient(canonical.id)
        return found is not None and found.name == item.wording

    return len(drafts) == len(items) and all(map(same, drafts, items, strict=True))


def _substitute(
    store: Store,
    name: str,
    draft: SubstituteDraft,
    *,
    saved: Saved,
    snapshot: Callable[[], fdc.Snapshot],
) -> Substitution:
    """A household substitute with its FDC food's numbers from the FDC Snapshot, and its
    Canonical Ingredient, Confirmed or new, written with Our Version. A refusal names the line.
    """
    edited = Edited(saved.recipe)
    try:
        canonical = chosen_canonical(store, draft.canonical, edited)
    except HTTPException as refusal:
        refuse("ingredients", name, refusal.detail)
    wording = draft.wording or canonical.name
    try:
        numbers = substitute_numbers(snapshot(), name, wording, draft.fdc_id, draft.portion_id)
    except HTTPException as refusal:
        refuse("ingredients", name, refusal.detail)
    saved.edits.append(edited)
    return Substitution(
        wording=wording,
        canonical_id=canonical.id,
        ratio=draft.ratio,
        note=draft.note,
        fdc_id=draft.fdc_id,
        portion_id=draft.portion_id,
        fdc=numbers,
    )


def _built(
    line_id: str,
    line: LineFields,
    old: IngredientFacts | None,
    *,
    store: Store,
    result: Edited,
    snapshot: Callable[[], fdc.Snapshot],
    recipes: Callable[[], list[Recipe]],
    now: datetime,
) -> IngredientFacts:
    """An Our Version line's facts as the editor gives them, built from `old` as a Review line
    edit builds them, with what else the edit writes in `result`. Its match and conversion are
    the editor's, even one kept from enrichment's.
    """
    fields = {name: getattr(line, name) for name in LineFields.model_fields}
    edit = EditLine(kind="line", line_id=line_id, **fields)
    facts = edited_line(
        store,
        result.recipe.id,
        edit,
        old,
        snapshot=snapshot,
        recipes=recipes,
        now=now,
        result=result,
    )
    return facts.model_copy(
        update={
            "match": _as_editors(facts.match, now),
            "conversion": _as_editors(facts.conversion, now),
        }
    )


def _as_editors[F: (MatchFact, ConversionFact)](fact: F | None, now: datetime) -> F | None:
    """The fact as the editor's: a match or conversion kept from the Original was enrichment's."""
    return fact if fact is None or fact.provenance == "editor" else by_editor(fact, now)


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


def _status(
    recipe: Recipe, stored: OurSteps, steps: OurSteps, facts: Mapping[str, StepFacts]
) -> EnrichmentStatus:
    """Pending when a step is new or its text changed; Awaiting Review, for the save to settle,
    when it was Pending and every edited or added step has its `facts` from enrich; else as it
    was, or Ready for a new Our Version.
    """
    before, after = _texts(stored), _texts(steps)
    if any(before.get(step_id) != text for step_id, text in after.items()):
        return "pending"
    if recipe.our_version_status == "pending" and facts.keys() >= after.keys():
        return "awaiting_review"
    return recipe.our_version_status or "ready"


def _texts(steps: OurSteps) -> dict[str, str]:
    """Each edited or added step's text, by its id."""
    return {**{i: s.text for i, s in steps.edit.items()}, **{a.id: a.text for a in steps.add}}


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
