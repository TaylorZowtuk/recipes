"""Enrich segments Our Version's steps through their own endpoint, which leaves the Original's
facts alone. Step Portions add up to at most 1 across the effective steps: an answer past that is
stored at what's left, and an Original change past it flags Our Version's step. An Our Version
save that removes a line, or changes its name or Canonical Ingredient, flags the unchanged steps
that use it.
"""

from typing import TYPE_CHECKING, Any

import pytest
from conftest import EDITOR, SNAPSHOT
from test_enrichment_review import FACTS, LLM, card, confirm, issue, stored, uses
from test_our_version import BRAISING, line, lines, save
from test_our_version_review import BROWN, REST, enriched, segmented, steps_draft
from test_review_edits import edit

from recipes.models import (
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


def test_its_issues_are_stored_on_our_versions_steps(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = pending(api_store)
    unsure = issue(1, "our_version.s2.segments", before=None, after=None, reason="Unsure")

    response = enrich_ours(editor_client, recipe, issues=[unsure.model_dump(mode="json")])

    assert response.status_code == 200, response.text
    assert open_issues(stored(api_store, recipe.id)) == {"our_version.s2.segments": "Unsure"}


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
    "an issue on the Original": (
        {"s2": brown(), "s5": REST_ANSWER},
        {"issues": [issue(1, "s2.segments").model_dump(mode="json")]},
        "An Enrichment Issue is on no fact: s2.segments",
    ),
    "a resolved issue": (
        {"s2": brown(), "s5": REST_ANSWER},
        {"issues": [issue(1, "our_version.s2.uses", status="resolved").model_dump(mode="json")]},
        "An Enrichment Issue arrives open, in no Confirm Batch",
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
    assert changed.our_version_status == "awaiting_review"


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


def reenrich(client: TestClient, recipe: Recipe, steps: dict[str, Any]) -> Response:
    body = {"enrichment_version": 3, "fdc_release": SNAPSHOT.release, "facts": {"steps": steps}}
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
    assert (flagged.before, flagged.after) == (None, None)
    assert changed.our_version_status == "awaiting_review"


@pytest.mark.parametrize(
    ("beef", "reason"),
    [
        (
            line(name="braising beef", canonical=BRAISING),
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
