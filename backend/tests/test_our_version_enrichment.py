"""Enrich segments Our Version's steps through their own endpoint, which leaves the Original's
facts alone. Step Portions add up to at most 1 across the effective steps: an answer past that is
stored at what's left, and an Original change past it flags Our Version's step. An Our Version
save that removes a line, or changes its name or Canonical Ingredient, flags the unchanged steps
that use it.
"""

from typing import TYPE_CHECKING, Any

import pytest
from conftest import EDITOR, SNAPSHOT
from test_enrichment_review import (
    BEEF,
    CONFIRMED,
    FACTS,
    LLM,
    card,
    confirm,
    issue,
    parse,
    stored,
    uses,
)
from test_our_version import BRAISING, line, lines, save
from test_our_version_review import BROWN, REST, enriched, segmented, segments, steps_draft
from test_review_edits import edit, line_edit

from recipes.models import (
    IngredientFacts,
    IngredientSegment,
    RecipeFacts,
    StepFacts,
    TextSegment,
    effective,
)

if TYPE_CHECKING:
    from fastapi.testclient import TestClient
    from httpx2 import Response

    from recipes.models import EnrichmentStatus, Recipe
    from recipes.store import Store


def text(v: str) -> dict[str, Any]:
    return {"t": "text", "v": v}


def beef(portion: float) -> dict[str, Any]:
    return {"t": "ingredient", "ref": "i1", "written": "beef", "portion": portion}


def answer(*segments: dict[str, Any]) -> dict[str, Any]:
    """A step's Segments as enrich answers them, with its uses summed from them."""
    summed: dict[str, float] = {}
    for segment in segments:
        if segment["t"] == "ingredient":
            summed[segment["ref"]] = summed.get(segment["ref"], 0) + segment["portion"]
    return {
        "segments": {**LLM, "segments": list(segments)},
        "uses": {**LLM, "uses": [{"ref": ref, "portion": p} for ref, p in summed.items()]},
    }


def brown(portion: float = 0.5) -> dict[str, Any]:
    return answer(text("Brown the "), beef(portion), text(" well."))


REST_ANSWER = answer(text(REST))


def enrich_ours(
    client: TestClient,
    recipe: Recipe,
    steps: dict[str, Any] | None = None,
    *,
    version: int | None = None,
    dry_run: bool = False,
    **fields: Any,
) -> Response:
    body = {
        "version": recipe.version if version is None else version,
        "steps": {"s2": brown(), "s5": REST_ANSWER} if steps is None else steps,
        **fields,
    }
    params = {"dry_run": "true"} if dry_run else {}
    return client.put(
        f"/api/recipes/{recipe.id}/our-version/enrichment",
        json=body,
        params=params,
        headers=EDITOR,
    )


def original(**steps: StepFacts) -> RecipeFacts:
    """The stew's facts, with these Original steps' facts."""
    return FACTS.model_copy(update={"steps": {**FACTS.steps, **steps}})


def uses_of(ref: str, portion: float) -> StepFacts:
    return StepFacts(uses=uses(uses=[{"ref": ref, "portion": portion}]))


def pending(store: Store, facts: RecipeFacts = FACTS) -> Recipe:
    """The stew, Ready, whose Our Version edits s2 and adds s5, both waiting for enrich."""
    return enriched(store, status="pending", step_facts={}, facts=facts)


def open_issues(recipe: Recipe) -> dict[str, str]:
    return {i.fact_id: i.reason for i in recipe.issues if i.status == "open"}


# Enriching Our Version's steps


def test_enriching_our_versions_steps_stores_them_in_its_facts_and_awaits_review(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = pending(api_store)

    response = enrich_ours(editor_client, recipe)

    assert response.status_code == 200, response.text
    changed = stored(api_store, recipe.id)
    assert changed.our_version is not None
    assert changed.our_version.facts.steps == {
        "s2": StepFacts.model_validate(brown()),
        "s5": StepFacts.model_validate(REST_ANSWER),
    }
    assert changed.facts == recipe.facts
    assert (changed.status, changed.our_version_status) == ("ready", "awaiting_review")
    assert changed.version == recipe.version + 1
    assert response.json() == changed.model_dump(mode="json")
    # The Original's four items, and Our Version's two steps.
    assert card(api_store, recipe.id)["needs_review"]["unconfirmed"] == 6
    assert card(api_store, recipe.id)["our_version_status"] == "awaiting_review"


def test_confirming_the_enriched_steps_makes_our_version_ready(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = pending(api_store)
    assert enrich_ours(editor_client, recipe).status_code == 200
    paths = [f"our_version.{s}.{k}" for s in ("s2", "s5") for k in ("segments", "uses")]

    response = confirm(editor_client, stored(api_store, recipe.id), *paths)

    assert response.status_code == 200, response.text
    assert stored(api_store, recipe.id).our_version_status == "ready"


def test_a_dry_run_returns_the_enriched_recipe_and_writes_nothing(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = pending(api_store)

    response = enrich_ours(editor_client, recipe, dry_run=True)

    assert response.status_code == 200, response.text
    assert response.json()["our_version_status"] == "awaiting_review"
    assert stored(api_store, recipe.id) == recipe


def test_only_an_editor_can_enrich_our_version(editor_client: TestClient, api_store: Store) -> None:
    recipe = pending(api_store)

    response = editor_client.put(
        f"/api/recipes/{recipe.id}/our-version/enrichment",
        json={"version": recipe.version, "steps": {}},
    )

    assert response.status_code == 403


@pytest.mark.parametrize(
    ("status", "code"), [("ready", 409), ("awaiting_review", 409), ("pending", 200)]
)
def test_only_a_pending_our_version_is_enriched(
    editor_client: TestClient, api_store: Store, status: EnrichmentStatus, code: int
) -> None:
    recipe = enriched(api_store, status=status, step_facts={})

    assert enrich_ours(editor_client, recipe).status_code == code


def test_a_recipe_changed_since_its_version_is_a_conflict(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = pending(api_store)

    response = enrich_ours(editor_client, recipe, version=recipe.version - 1)

    assert response.status_code == 409
    assert stored(api_store, recipe.id) == recipe


REFUSALS: dict[str, tuple[dict[str, Any], dict[str, Any], str]] = {
    "an unchanged step": (
        {"s1": answer(text("Toss the beef in flour and brown it in the oil in batches."))},
        {},
        "s1 isn't an Our Version step waiting for enrich",
    ),
    "a step the Original lacks": (
        {"s9": REST_ANSWER},
        {},
        "s9 isn't an Our Version step waiting for enrich",
    ),
    "segments that aren't the step's text": (
        {"s2": answer(text("Brown it.")), "s5": REST_ANSWER},
        {},
        "Step s2's segments aren't its text",
    ),
    "a line Our Version removed": (
        {
            "s2": answer(
                text("Brown the "),
                {"t": "ingredient", "ref": "i9", "written": "beef", "portion": 1},
                text(" well."),
            ),
            "s5": REST_ANSWER,
        },
        {},
        "The recipe has no line i9",
    ),
    "a step left out": ({"s2": brown()}, {}, "Step s5 needs its segments"),
    "a step without segments": (
        {"s2": brown(), "s5": {"uses": {**LLM, "uses": []}}},
        {},
        "Step s5 needs its segments",
    ),
    "a confirmed fact": (
        {"s2": brown(), "s5": {"segments": {**LLM, "confirmed": True, "segments": [text(REST)]}}},
        {},
        "Enrichment can't confirm a fact",
    ),
}


@pytest.mark.parametrize(("steps", "fields", "detail"), REFUSALS.values(), ids=REFUSALS.keys())
def test_an_answer_it_cant_take_is_refused(
    editor_client: TestClient,
    api_store: Store,
    steps: dict[str, Any],
    fields: dict[str, Any],
    detail: str,
) -> None:
    recipe = pending(api_store)
    ours = recipe.our_version
    assert ours is not None
    removed = ours.ingredients.model_copy(update={"remove": ["i9"]})
    api_store.update_recipe(
        recipe.model_copy(update={"our_version": ours.model_copy(update={"ingredients": removed})})
    )
    recipe = stored(api_store, recipe.id)

    response = enrich_ours(editor_client, recipe, steps, **fields)

    assert response.status_code == 422, response.text
    assert detail in response.json()["detail"]
    assert stored(api_store, recipe.id) == recipe


def test_a_step_enrich_already_segmented_is_refused(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = enriched(api_store, status="pending", step_facts={"s5": segmented(REST)})

    response = enrich_ours(editor_client, recipe)

    assert response.status_code == 422
    assert "s5 isn't an Our Version step waiting for enrich" in response.json()["detail"]


# Step Portions across the effective steps


def test_an_answer_past_all_of_a_line_is_stored_at_whats_left_and_flagged(
    editor_client: TestClient, api_store: Store
) -> None:
    # The Original's unchanged first step uses a quarter of the beef.
    recipe = pending(api_store, original(s1=uses_of("i1", 0.25)))

    response = enrich_ours(editor_client, recipe, {"s2": brown(1), "s5": REST_ANSWER})

    assert response.status_code == 200, response.text
    changed = stored(api_store, recipe.id)
    assert changed.our_version is not None
    s2 = changed.our_version.facts.steps["s2"]
    assert s2.segments is not None
    assert s2.uses is not None
    assert s2.segments.segments[1] == IngredientSegment(ref="i1", written="beef", portion=0.75)
    assert [(u.ref, u.portion) for u in s2.uses.uses] == [("i1", 0.75)]
    assert open_issues(changed) == {
        "our_version.s2.uses": "Step 1 uses stewing beef too, so this step has what's left of it"
    }
    assert [i.settles_on_confirm for i in changed.issues] == [True]
    assert changed.our_version_status == "awaiting_review"


def test_answering_two_steps_that_share_a_line_stores_the_later_at_whats_left(
    editor_client: TestClient, api_store: Store
) -> None:
    rest = answer(text("Rest the "), beef(0.75), text(" for ten minutes."))
    recipe = pending(api_store)
    ours = recipe.our_version
    assert ours is not None
    s5 = ours.steps.add[0].model_copy(update={"text": "Rest the beef for ten minutes."})
    texts = ours.steps.model_copy(update={"add": [s5]})
    api_store.update_recipe(
        recipe.model_copy(update={"our_version": ours.model_copy(update={"steps": texts})})
    )
    recipe = stored(api_store, recipe.id)

    response = enrich_ours(editor_client, recipe, {"s2": brown(0.75), "s5": rest})

    assert response.status_code == 200, response.text
    changed = stored(api_store, recipe.id)
    assert changed.our_version is not None
    s5 = changed.our_version.facts.steps["s5"]
    assert s5.uses is not None
    assert [(u.ref, u.portion) for u in s5.uses.uses] == [("i1", 0.25)]
    assert open_issues(changed) == {
        "our_version.s5.uses": "Step 2 uses stewing beef too, so this step has what's left of it"
    }


def test_an_answer_with_none_of_a_line_left_names_it_as_plain_text(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = pending(api_store, original(s1=uses_of("i1", 1)))

    response = enrich_ours(editor_client, recipe, {"s2": brown(0.5), "s5": REST_ANSWER})

    assert response.status_code == 200, response.text
    changed = stored(api_store, recipe.id)
    assert changed.our_version is not None
    s2 = changed.our_version.facts.steps["s2"]
    assert s2.segments is not None
    assert s2.segments.segments[1] == TextSegment(v="beef")
    assert s2.uses is not None
    assert s2.uses.uses == []
    assert open_issues(changed) == {
        "our_version.s2.uses": "Step 1 uses stewing beef too, so this step has none of it"
    }


def test_the_step_our_version_replaces_doesnt_count_against_its_own(
    editor_client: TestClient, api_store: Store
) -> None:
    # The Original's s2 is what Our Version's s2 replaces, so its use is not the effective one.
    recipe = pending(api_store, original(s2=uses_of("i1", 1)))

    response = enrich_ours(editor_client, recipe, {"s2": brown(1), "s5": REST_ANSWER})

    assert response.status_code == 200, response.text
    assert open_issues(stored(api_store, recipe.id)) == {}


def test_the_originals_own_enrichment_stays_strict(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = enriched(api_store, status="ready", step_facts={"s2": segmented(BROWN)})
    over = {"s1": {"uses": {**LLM, "uses": [{"ref": "i1", "portion": 0.75}]}}} | {
        "s3": {"uses": {**LLM, "uses": [{"ref": "i1", "portion": 0.5}]}}
    }

    response = reenrich(editor_client, recipe, over)

    assert response.status_code == 422
    assert "The steps use more than all of i1" in response.json()["detail"]


# Original changes past all of a line with Our Version's steps


def test_reenriching_the_original_past_all_of_a_line_with_our_versions_steps_flags_them(
    editor_client: TestClient, api_store: Store
) -> None:
    # Our Version's s2 uses half the beef; the Original's s1 now takes three quarters.
    recipe = enriched(api_store, status="ready", step_facts={"s2": segmented(BROWN)})
    facts = {"s1": {"uses": {**LLM, "uses": [{"ref": "i1", "portion": 0.75}]}}}

    response = reenrich(editor_client, recipe, facts)

    assert response.status_code == 200, response.text
    changed = stored(api_store, recipe.id)
    # Re-enriched without the beef's parse, the line is named by its text.
    assert open_issues(changed) == {
        "our_version.s2.uses": "Step 1 uses 900 g stewing beef, cubed too: together more than "
        "all of it"
    }
    assert changed.our_version_status == "awaiting_review"


def test_an_original_step_edit_past_all_of_a_line_with_our_versions_steps_flags_them(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = enriched(
        api_store,
        status="ready",
        step_facts={"s2": segmented(BROWN)},
        facts=original(s1=uses_of("i1", 0.25)),
    )

    response = edit(editor_client, recipe, kind="step", step_id="s1", portions=[1], durations=[])

    assert response.status_code == 200, response.text
    changed = stored(api_store, recipe.id)
    assert open_issues(changed) == {
        "our_version.s2.uses": "Step 1 uses stewing beef too: together more than all of it"
    }
    assert changed.our_version_status == "awaiting_review"


def test_confirming_a_step_that_uses_too_much_leaves_it_flagged(
    editor_client: TestClient, api_store: Store
) -> None:
    # Only an edit of either step settles using more than all of a line.
    recipe = enriched(
        api_store,
        status="ready",
        step_facts={"s2": segmented(BROWN)},
        facts=original(s1=uses_of("i1", 0.25)),
    )
    over = edit(editor_client, recipe, kind="step", step_id="s1", portions=[1], durations=[])
    assert over.status_code == 200, over.text
    flagged = stored(api_store, recipe.id)
    assert [i.settles_on_confirm for i in flagged.issues] == [False]

    response = confirm(editor_client, flagged, "our_version.s2.segments", "our_version.s2.uses")

    assert response.status_code == 200, response.text
    changed = stored(api_store, recipe.id)
    assert list(open_issues(changed)) == ["our_version.s2.uses"]
    assert changed.our_version_status == "awaiting_review"


def test_reenriching_the_original_back_within_all_of_a_line_settles_the_flag(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = enriched(api_store, status="ready", step_facts={"s2": segmented(BROWN)})
    over = {"s1": {"uses": {**LLM, "uses": [{"ref": "i1", "portion": 0.75}]}}}
    assert reenrich(editor_client, recipe, over).status_code == 200
    confirmed = confirm(
        editor_client,
        stored(api_store, recipe.id),
        "our_version.s2.segments",
        "our_version.s2.uses",
    )
    assert confirmed.status_code == 200, confirmed.text
    flagged = stored(api_store, recipe.id)
    assert list(open_issues(flagged)) == ["our_version.s2.uses"]
    assert flagged.our_version_status == "awaiting_review"
    back = {"s1": {"uses": {**LLM, "uses": [{"ref": "i1", "portion": 0.25}]}}}

    response = reenrich(editor_client, flagged, back)

    assert response.status_code == 200, response.text
    changed = stored(api_store, recipe.id)
    assert open_issues(changed) == {}
    assert [(i.status, i.confirm_batch) for i in changed.issues] == [("resolved", None)]
    assert changed.our_version_status == "ready"


def test_a_second_original_edit_past_all_of_a_line_flags_the_step_once(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = enriched(
        api_store,
        status="ready",
        step_facts={"s2": segmented(BROWN)},
        facts=original(s1=uses_of("i1", 0.25)),
    )
    over = edit(editor_client, recipe, kind="step", step_id="s1", portions=[1], durations=[])
    assert over.status_code == 200, over.text

    response = edit(
        editor_client,
        stored(api_store, recipe.id),
        kind="step",
        step_id="s1",
        portions=[0.75],
        durations=[],
    )

    assert response.status_code == 200, response.text
    assert [i.status for i in stored(api_store, recipe.id).issues] == ["open"]


def test_an_open_issue_on_another_line_doesnt_hide_a_step_using_too_much(
    editor_client: TestClient, api_store: Store
) -> None:
    mentions = issue(
        1,
        "our_version.s2.uses",
        before=None,
        after=None,
        reason="Mentions parsley, which Our Version removed",
        settles_on_confirm=True,
    )
    recipe = enriched(
        api_store,
        status="awaiting_review",
        step_facts={"s2": segmented(BROWN)},
        facts=original(s1=uses_of("i1", 0.25)),
        issues=(mentions,),
    )

    response = edit(editor_client, recipe, kind="step", step_id="s1", portions=[1], durations=[])

    assert response.status_code == 200, response.text
    reasons = [i.reason for i in stored(api_store, recipe.id).issues if i.status == "open"]
    assert reasons == [
        "Mentions parsley, which Our Version removed",
        "Step 1 uses stewing beef too: together more than all of it",
    ]


def test_an_original_edit_back_within_all_of_a_line_settles_the_flag(
    editor_client: TestClient, api_store: Store
) -> None:
    # The Original edit was the mistake: setting it back settles the flag like an edit.
    rest = StepFacts(segments=segments(REST, **CONFIRMED), uses=uses(**CONFIRMED))
    recipe = enriched(
        api_store,
        status="ready",
        step_facts={"s2": segmented(BROWN, **CONFIRMED), "s5": rest},
        facts=original(s1=uses_of("i1", 0.25)),
    )
    over = edit(editor_client, recipe, kind="step", step_id="s1", portions=[1], durations=[])
    assert over.status_code == 200, over.text
    assert stored(api_store, recipe.id).our_version_status == "awaiting_review"

    response = edit(
        editor_client,
        stored(api_store, recipe.id),
        kind="step",
        step_id="s1",
        portions=[0.25],
        durations=[],
    )

    assert response.status_code == 200, response.text
    changed = stored(api_store, recipe.id)
    assert open_issues(changed) == {}
    assert [(i.status, i.confirm_batch) for i in changed.issues] == [("resolved", None)]
    assert (changed.our_version_status, changed.our_version_ready_batch) == ("ready", None)


def both(portion: float) -> StepFacts:
    """A step's use of the beef (i1) and the parsley (i9), each `portion` of its line."""
    return StepFacts(uses=uses(uses=[{"ref": ref, "portion": portion} for ref in ("i1", "i9")]))


def test_two_lines_past_all_of_them_on_one_step_flag_it_twice(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = enriched(
        api_store, status="ready", step_facts={"s2": both(0.5)}, facts=original(s1=both(0.25))
    )

    response = edit(editor_client, recipe, kind="step", step_id="s1", portions=[1, 1], durations=[])

    assert response.status_code == 200, response.text
    flags = [(i.fact_id, i.line_id) for i in stored(api_store, recipe.id).issues]
    assert flags == [("our_version.s2.uses", "i1"), ("our_version.s2.uses", "i9")]


def test_two_lines_with_one_name_are_flagged_apart(
    editor_client: TestClient, api_store: Store
) -> None:
    # Butter in the crust and butter in the filling: the same name, two lines.
    ingredients = {**FACTS.ingredients, "i9": IngredientFacts(parse=parse("stewing beef"))}
    facts = original(s1=both(0.25)).model_copy(update={"ingredients": ingredients})
    recipe = enriched(api_store, status="ready", step_facts={"s2": both(0.5)}, facts=facts)
    first = edit(editor_client, recipe, kind="step", step_id="s1", portions=[1, 0.25], durations=[])
    assert first.status_code == 200, first.text

    response = edit(
        editor_client,
        stored(api_store, recipe.id),
        kind="step",
        step_id="s1",
        portions=[1, 1],
        durations=[],
    )

    assert response.status_code == 200, response.text
    open_lines = [i.line_id for i in stored(api_store, recipe.id).issues if i.status == "open"]
    assert open_lines == ["i1", "i9"]


def test_an_our_version_save_dropping_the_other_use_settles_the_flag(
    editor_client: TestClient, api_store: Store
) -> None:
    # s2 and s5 each use half the beef; s1 taking a quarter flags both. Rewording s2 drops its
    # use until enrich, so s5, which the save leaves alone, is back within all of it.
    recipe = enriched(api_store, status="ready", facts=original(s1=uses_of("i1", 0.1)))
    over = edit(editor_client, recipe, kind="step", step_id="s1", portions=[0.25], durations=[])
    assert over.status_code == 200, over.text
    assert set(open_issues(stored(api_store, recipe.id))) == {
        "our_version.s2.uses",
        "our_version.s5.uses",
    }

    response = save(
        editor_client, stored(api_store, recipe.id), steps_draft(s2="Brown the beef in batches.")
    )

    assert response.status_code == 200, response.text
    changed = stored(api_store, recipe.id)
    assert open_issues(changed) == {}
    assert changed.our_version_status == "pending"


def test_renaming_a_flagged_line_doesnt_flag_its_step_again(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = enriched(
        api_store,
        status="ready",
        step_facts={"s2": segmented(BROWN)},
        facts=original(s1=uses_of("i1", 0.25)),
    )
    over = edit(editor_client, recipe, kind="step", step_id="s1", portions=[1], durations=[])
    assert over.status_code == 200, over.text
    renamed = line_edit(name="beef chuck", canonical=BRAISING)

    response = edit(editor_client, stored(api_store, recipe.id), **renamed)

    assert response.status_code == 200, response.text
    kept = stored(api_store, recipe.id).issues
    assert [i.status for i in kept] == ["open"]
    assert kept[0].reason == "Step 1 uses beef chuck too: together more than all of it"


def test_an_original_step_edit_within_all_of_a_line_flags_nothing(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = enriched(
        api_store,
        status="ready",
        step_facts={"s2": segmented(BROWN)},
        facts=original(s1=uses_of("i1", 0.25)),
    )

    response = edit(editor_client, recipe, kind="step", step_id="s1", portions=[0.5], durations=[])

    assert response.status_code == 200, response.text
    changed = stored(api_store, recipe.id)
    assert open_issues(changed) == {}
    assert changed.our_version_status == "ready"


def test_reenriching_an_unchanged_steps_facts_settles_its_issues(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = flaggable(api_store, PARSLEY)
    draft = {**steps_draft(), "ingredients": lines(remove=["i9"])}
    assert save(editor_client, recipe, draft).status_code == 200
    flagged = stored(api_store, recipe.id)
    assert list(open_issues(flagged)) == ["our_version.s4.uses"]
    s4 = {"uses": {**LLM, "uses": [{"ref": "i1", "portion": 0.25}]}}

    response = reenrich(editor_client, flagged, {"s1": PARSLEY.steps["s1"].model_dump(), "s4": s4})

    assert response.status_code == 200, response.text
    changed = stored(api_store, recipe.id)
    assert open_issues(changed) == {}
    assert changed.our_version_status == "ready"


@pytest.mark.parametrize(
    ("ingredients", "reason"),
    [
        (lines(remove=["i9"]), "Mentions parsley, which Our Version removed"),
        (
            lines(edit={"i9": line(name="chives", fdc_id=None)}),
            "Mentions parsley, which Our Version changed",
        ),
    ],
    ids=["removed", "renamed"],
)
def test_reenriching_an_unchanged_step_with_a_line_our_version_changed_flags_it(
    editor_client: TestClient, api_store: Store, ingredients: dict[str, Any], reason: str
) -> None:
    recipe = flaggable(api_store, original(s1=uses_of("i1", 0.5)))
    draft = {**steps_draft(), "ingredients": ingredients}
    assert save(editor_client, recipe, draft).status_code == 200
    saved = stored(api_store, recipe.id)
    assert saved.our_version_status == "ready"
    s3 = {"uses": {**LLM, "uses": [{"ref": "i9", "portion": 1}]}}

    parses = {i: {"parse": FACTS.ingredients[i].model_dump()["parse"]} for i in ("i1", "i9")}

    response = reenrich(
        editor_client, saved, {"s1": uses_of("i1", 0.5).model_dump(), "s3": s3}, parses
    )

    assert response.status_code == 200, response.text
    changed = stored(api_store, recipe.id)
    assert {k: v for k, v in open_issues(changed).items() if k.startswith("our_version.")} == {
        "our_version.s3.uses": reason
    }
    [flagged] = [i for i in changed.issues if i.fact_id == "our_version.s3.uses"]
    assert flagged.settles_on_confirm
    assert changed.our_version_status == "awaiting_review"


def reenrich(
    client: TestClient,
    recipe: Recipe,
    steps: dict[str, Any],
    ingredients: dict[str, Any] | None = None,
) -> Response:
    facts = {"steps": steps, "ingredients": ingredients or {}}
    body = {"enrichment_version": 3, "fdc_release": SNAPSHOT.release, "facts": facts}
    return client.put(
        f"/api/recipes/{recipe.id}/enrichment",
        json=body,
        params={"version": recipe.version},
        headers=EDITOR,
    )


# Steps an Our Version save affects

PARSLEY = original(s4=uses_of("i9", 1), s1=uses_of("i1", 0.5))


def flaggable(store: Store, facts: RecipeFacts) -> Recipe:
    """The stew with these facts, its Our Version Ready, editing s2 and adding s5 unsegmented."""
    return enriched(store, status="ready", facts=facts, step_facts={})


def test_removing_a_line_flags_the_unchanged_steps_that_use_it(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = flaggable(api_store, PARSLEY)

    response = save(editor_client, recipe, {**steps_draft(), "ingredients": lines(remove=["i9"])})

    assert response.status_code == 200, response.text
    changed = stored(api_store, recipe.id)
    assert open_issues(changed) == {
        "our_version.s4.uses": "Mentions parsley, which Our Version removed"
    }
    [flagged] = [i for i in changed.issues if i.status == "open"]
    assert (flagged.before, flagged.after, flagged.settles_on_confirm) == (None, None, True)
    assert changed.our_version_status == "awaiting_review"


@pytest.mark.parametrize(
    ("beef", "reason"),
    [
        (
            line(name="beef chuck", canonical={"kind": "existing", "id": BEEF.id}),
            "Mentions stewing beef, which Our Version changed",
        ),
        (
            line(canonical=BRAISING),
            "Mentions stewing beef, which Our Version changed",
        ),
    ],
    ids=["its name", "its Canonical Ingredient"],
)
def test_changing_a_lines_name_or_canonical_ingredient_flags_the_unchanged_steps_that_use_it(
    editor_client: TestClient, api_store: Store, beef: dict[str, Any], reason: str
) -> None:
    recipe = flaggable(api_store, PARSLEY)

    draft = {**steps_draft(), "ingredients": lines(edit={"i1": beef})}

    response = save(editor_client, recipe, draft)

    assert response.status_code == 200, response.text
    changed = stored(api_store, recipe.id)
    # The wording fix may also ask about the Original's own beef line.
    ours = {k: v for k, v in open_issues(changed).items() if k.startswith("our_version.")}
    assert ours == {"our_version.s1.uses": reason}
    assert changed.our_version_status == "awaiting_review"


def test_a_wording_spread_to_a_line_the_save_left_alone_affects_no_step(
    editor_client: TestClient, api_store: Store
) -> None:
    # Our Version's i1 keeps its identity; only the added line's Canonical Ingredient changes,
    # which the wording spreads to i1 too, but s1's line isn't one the save rebuilt.
    recipe = flaggable(api_store, PARSLEY)
    added = line(after="i1", canonical={"kind": "existing", "id": BEEF.id})
    first = {**steps_draft(), "ingredients": lines(edit={"i1": line()}, add=[added])}
    assert save(editor_client, recipe, first).status_code == 200
    saved = stored(api_store, recipe.id)
    again = lines(edit={"i1": line()}, add=[added | {"id": "i10", "canonical": BRAISING}])

    response = save(editor_client, saved, {**first, "ingredients": again})

    assert response.status_code == 200, response.text
    changed = stored(api_store, recipe.id)
    assert {k: v for k, v in open_issues(changed).items() if k.startswith("our_version.s")} == {}


def test_changing_a_lines_amount_affects_no_step(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = flaggable(api_store, PARSLEY)

    response = save(
        editor_client, recipe, {**steps_draft(), "ingredients": lines(edit={"i1": line()})}
    )

    assert response.status_code == 200, response.text
    changed = stored(api_store, recipe.id)
    assert open_issues(changed) == {}
    assert changed.our_version_status == "ready"


def test_a_step_our_version_replaces_isnt_affected(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = flaggable(api_store, original(s2=uses_of("i9", 1)))

    response = save(editor_client, recipe, {**steps_draft(), "ingredients": lines(remove=["i9"])})

    assert response.status_code == 200, response.text
    assert open_issues(stored(api_store, recipe.id)) == {}


def test_a_line_removed_before_affects_no_step_again(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = flaggable(api_store, PARSLEY)
    draft = {**steps_draft(), "ingredients": lines(remove=["i9"])}
    assert save(editor_client, recipe, draft).status_code == 200
    flagged = stored(api_store, recipe.id)
    assert confirm(editor_client, flagged, "our_version.s4.uses").status_code == 200

    response = save(editor_client, stored(api_store, recipe.id), {**draft, "note": "Less salt"})

    assert response.status_code == 200, response.text
    changed = stored(api_store, recipe.id)
    assert open_issues(changed) == {}
    assert changed.our_version_status == "ready"


def test_confirming_an_affected_step_as_it_is_settles_it(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = flaggable(api_store, PARSLEY)
    draft = {**steps_draft(), "ingredients": lines(remove=["i9"])}
    assert save(editor_client, recipe, draft).status_code == 200

    response = confirm(editor_client, stored(api_store, recipe.id), "our_version.s4.uses")

    assert response.status_code == 200, response.text
    changed = stored(api_store, recipe.id)
    assert open_issues(changed) == {}
    assert changed.our_version_status == "ready"


def test_editing_an_affected_step_settles_it(editor_client: TestClient, api_store: Store) -> None:
    recipe = flaggable(api_store, PARSLEY)
    draft = {**steps_draft(), "ingredients": lines(remove=["i9"])}
    assert save(editor_client, recipe, draft).status_code == 200
    s4 = {"text": "Add the carrots and parsnips and simmer 45 minutes more."}
    steps = lines(edit={"s2": {"text": BROWN}, "s4": s4}, add=steps_draft()["steps"]["add"])

    response = save(editor_client, stored(api_store, recipe.id), {**draft, "steps": steps})

    assert response.status_code == 200, response.text
    changed = stored(api_store, recipe.id)
    assert open_issues(changed) == {}
    assert changed.our_version_status == "pending"


def test_the_effective_step_shows_a_removed_lines_segment_as_its_text(
    editor_client: TestClient, api_store: Store
) -> None:
    parsley = StepFacts.model_validate(
        answer(
            text("Finish with "),
            {"t": "ingredient", "ref": "i9", "written": "parsley", "portion": 1},
            text("."),
        )
    )
    recipe = flaggable(api_store, original(s4=parsley))
    assert (
        save(
            editor_client, recipe, {**steps_draft(), "ingredients": lines(remove=["i9"])}
        ).status_code
        == 200
    )

    s4 = effective(stored(api_store, recipe.id)).facts.steps["s4"]

    assert s4.segments is not None
    assert [s.t for s in s4.segments.segments] == ["text", "text", "text"]
    assert s4.segments.segments[1] == TextSegment(v="parsley")
    assert s4.uses is not None
    assert s4.uses.uses == []
