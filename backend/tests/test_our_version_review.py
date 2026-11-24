"""Our Version's steps as Review Items: the effective lines enrich segments them against, what a
save keeps of their facts, and how confirming and undoing them moves the Our Version Status. The
Original's own Review Items and status stay as they are.
"""

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest
from test_enrichment_review import (
    CONFIRMED,
    FACTS,
    LLM,
    STEW,
    card,
    confirm,
    issue,
    stored,
    undo,
    uses,
)
from test_our_version import line, lines, ready, remove, save

from recipes.models import (
    AddedStep,
    Effective,
    EnrichmentIssue,
    EnrichmentStatus,
    IngredientFacts,
    Original,
    OurStep,
    OurSteps,
    OurVersion,
    Recipe,
    RecipeFacts,
    SegmentsFact,
    StepFacts,
    effective,
    fact_of,
    needs_review,
    review_items,
)

if TYPE_CHECKING:
    from fastapi.testclient import TestClient

    from recipes.store import Store

# Cases the PWA's ourVersion test checks too, so the two effective recipes can't drift apart.
SHARED = json.loads((Path(__file__).parent / "fixtures" / "effective_lines.json").read_text())


@pytest.mark.parametrize("case", SHARED["cases"], ids=[c["name"] for c in SHARED["cases"]])
def test_the_effective_lines_are_the_shared_cases(case: dict[str, Any]) -> None:
    given = case["recipe"]
    ours = given["our_version"]
    recipe = STEW.model_copy(
        update={
            "original": Original.model_validate(
                {**STEW.original.model_dump(by_alias=True), **given["original"]}
            ),
            "facts": RecipeFacts.model_validate(given["facts"]),
            "our_version": OurVersion.model_validate(ours) if ours else None,
            "our_version_status": "ready" if ours else None,
        }
    )

    assert effective(recipe) == Effective.model_validate(case["expected"])


def segments(text: str, **fields: Any) -> SegmentsFact:
    return SegmentsFact.model_validate({**LLM, "segments": [{"t": "text", "v": text}], **fields})


def segmented(text: str, **fields: Any) -> StepFacts:
    """A step's facts as enrich gives them: its text as one Segment, and a use of the beef."""
    return StepFacts(
        segments=segments(text, **fields),
        uses=uses(uses=[{"ref": "i1", "portion": 0.5}], **fields),
    )


BROWN, REST = "Brown the beef well.", "Rest for ten minutes."


def enriched(
    store: Store,
    *,
    status: EnrichmentStatus = "awaiting_review",
    issues: tuple[EnrichmentIssue, ...] = (),
    facts: RecipeFacts = FACTS,
    step_facts: dict[str, StepFacts] | None = None,
    **fields: object,
) -> Recipe:
    """The stew, Ready, whose Our Version edits s2 and adds s5, both segmented by enrich and not
    yet confirmed.
    """
    recipe = ready(store, facts)
    ours = OurVersion(
        steps=OurSteps(
            edit={"s2": OurStep(text=BROWN)},
            add=[AddedStep(id="s5", after="s4", text=REST)],
        ),
        facts=RecipeFacts(
            steps={"s2": segmented(BROWN), "s5": segmented(REST)}
            if step_facts is None
            else step_facts
        ),
        edited_at=datetime(2026, 11, 1, tzinfo=UTC),
    )
    store.update_recipe(
        recipe.model_copy(
            update={
                "our_version": ours,
                "our_version_status": status,
                "our_version_last_step": 5,
                "issues": list(issues),
                **fields,
            }
        )
    )
    return stored(store, recipe.id)


def steps_draft(**steps: str) -> dict[str, Any]:
    """The stew's Our Version steps as the editor saves them: s2 edited, s5 added."""
    texts = {"s2": BROWN, "s5": REST, **steps}
    added = [{"id": "s5", "after": "s4", "text": texts["s5"]}] if texts["s5"] else []
    return {"steps": lines(edit={"s2": {"text": texts["s2"]}}, add=added)}


# What a save keeps


def test_a_save_keeps_the_facts_of_the_steps_whose_text_it_keeps(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = enriched(api_store, status="ready")
    draft = {**steps_draft(), "ingredients": lines(edit={"i1": line()})}

    response = save(editor_client, recipe, draft)

    assert response.status_code == 200, response.text
    ours = stored(api_store, recipe.id).our_version
    assert ours is not None
    assert ours.facts.steps == {"s2": segmented(BROWN), "s5": segmented(REST)}
    assert response.json()["our_version_status"] == "ready"


def test_a_save_drops_the_facts_of_the_steps_it_edits_again_or_removes(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = enriched(api_store, status="ready")

    response = save(editor_client, recipe, steps_draft(s2="Brown the beef in batches.", s5=""))

    assert response.status_code == 200, response.text
    ours = stored(api_store, recipe.id).our_version
    assert ours is not None
    assert ours.facts.steps == {}


def test_editing_a_step_again_while_awaiting_review_makes_it_pending_and_settles_its_issues(
    editor_client: TestClient, api_store: Store
) -> None:
    on_s2, on_s5 = (
        issue(1, "our_version.s2.uses", status="open"),
        issue(2, "our_version.s5.segments", status="open"),
    )
    recipe = enriched(api_store, issues=(on_s2, on_s5))

    response = save(editor_client, recipe, steps_draft(s2="Brown the beef in batches."))

    assert response.status_code == 200, response.text
    changed = stored(api_store, recipe.id)
    assert changed.our_version_status == "pending"
    assert {i.fact_id: i.status for i in changed.issues} == {
        "our_version.s2.uses": "resolved",
        "our_version.s5.segments": "open",
    }
    assert changed.our_version is not None
    assert list(changed.our_version.facts.steps) == ["s5"]


def test_a_save_that_leaves_steps_unconfirmed_keeps_our_version_awaiting_review(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = enriched(api_store)

    response = save(editor_client, recipe, {**steps_draft(), "note": "More pepper"})

    assert response.status_code == 200, response.text
    assert response.json()["our_version_status"] == "awaiting_review"


# Review Items


def test_our_versions_steps_are_review_items_apart_from_the_originals() -> None:
    ours = OurVersion(
        steps=OurSteps(edit={"s1": OurStep(text=BROWN)}),
        facts=RecipeFacts(
            ingredients={"i1": FACTS.ingredients["i1"]}, steps={"s1": segmented(BROWN)}
        ),
        edited_at=datetime(2026, 11, 1, tzinfo=UTC),
    )
    recipe = STEW.model_copy(
        update={
            "facts": FACTS,
            "our_version": ours,
            "our_version_status": "awaiting_review",
            "issues": [
                issue(1, "our_version.i2.match", before=None, after=None),
                issue(2, "our_version.s3.uses", before=None, after=None),
            ],
        }
    )

    assert review_items(recipe) == {
        "i1": ["i1.parse", "i1.match", "i1.conversion"],
        "i9": ["i9.parse"],
        "s1": ["s1.uses"],
        "difficulty": ["difficulty"],
        "our_version.i1": [
            "our_version.i1.parse",
            "our_version.i1.match",
            "our_version.i1.conversion",
        ],
        "our_version.s1": ["our_version.s1.segments", "our_version.s1.uses"],
        "our_version.i2": ["our_version.i2.match"],
        "our_version.s3": ["our_version.s3.uses"],
    }
    left = needs_review(recipe)
    assert (left.open_issues, left.unconfirmed, left.flagged) == (2, 8, 2)


def test_an_our_version_path_names_the_fact_in_its_facts_map() -> None:
    ours = OurVersion(
        facts=RecipeFacts(
            ingredients={"i1": FACTS.ingredients["i9"]}, steps={"s2": segmented(BROWN)}
        ),
        edited_at=datetime(2026, 11, 1, tzinfo=UTC),
    )
    recipe = STEW.model_copy(
        update={"facts": FACTS, "our_version": ours, "our_version_status": "awaiting_review"}
    )

    assert fact_of(recipe, "our_version.s2.segments") == segments(BROWN)
    assert fact_of(recipe, "our_version.i1.parse") == FACTS.ingredients["i9"].parse
    assert fact_of(recipe, "i1.parse") == FACTS.ingredients["i1"].parse
    assert fact_of(recipe, "our_version.s1.uses") is None
    assert fact_of(STEW, "our_version.s2.segments") is None


@pytest.mark.usefixtures("editor_client")
def test_the_card_counts_our_versions_review_items_and_the_originals(
    api_store: Store,
) -> None:
    recipe = enriched(api_store, issues=(issue(1, "our_version.i9.match", after=None),))

    # The Original's four (i1, i9, s1, Difficulty), and Our Version's two steps and flagged line.
    assert card(api_store, recipe.id)["needs_review"] == {
        "open_issues": 1,
        "unconfirmed": 7,
        "flagged": 1,
    }


# Confirming and undoing


def test_confirming_our_versions_last_steps_makes_it_ready_and_undo_moves_it_back(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = enriched(api_store)
    s2 = ["our_version.s2.segments", "our_version.s2.uses"]
    first = confirm(editor_client, recipe, *s2)
    assert first.status_code == 200, first.text
    assert first.json()["recipe"]["our_version_status"] == "awaiting_review"

    s5 = ["our_version.s5.segments", "our_version.s5.uses"]
    response = confirm(editor_client, stored(api_store, recipe.id), *s5)

    assert response.status_code == 200, response.text
    batch = response.json()["confirm_batch"]
    confirmed = stored(api_store, recipe.id)
    assert confirmed.our_version is not None
    s5 = confirmed.our_version.facts.steps["s5"]
    assert s5.segments is not None
    assert (s5.segments.confirmed, s5.segments.confirm_batch) == (True, batch)
    assert (confirmed.our_version_status, confirmed.our_version_ready_batch) == ("ready", batch)
    # The Original's facts, Review Items and status are its own.
    assert confirmed.facts == recipe.facts
    assert (confirmed.status, response.json()["ready"]) == ("ready", False)
    assert card(api_store, recipe.id)["needs_review"]["unconfirmed"] == 4

    undone = undo(editor_client, recipe.id, batch)

    assert undone.status_code == 200, undone.text
    back = stored(api_store, recipe.id)
    assert back.our_version is not None
    assert back.our_version.facts.steps["s5"] == segmented(REST)
    assert back.our_version.facts.steps["s2"].segments
    assert back.our_version.facts.steps["s2"].segments.confirmed
    assert (back.our_version_status, back.our_version_ready_batch) == ("awaiting_review", None)


def test_confirming_an_affected_step_as_it_is_settles_its_issue(
    editor_client: TestClient, api_store: Store
) -> None:
    # s3 is the Original's, unchanged, and uses the parsley Our Version removed.
    affected = issue(1, "our_version.s3.uses", before=None, after=None, settles_on_confirm=True)
    recipe = enriched(api_store, issues=(affected,), step_facts={})

    response = confirm(editor_client, recipe, "our_version.s3.uses")

    assert response.status_code == 200, response.text
    batch = response.json()["confirm_batch"]
    confirmed = stored(api_store, recipe.id)
    [settled] = confirmed.issues
    assert (settled.status, settled.confirm_batch) == ("resolved", batch)
    assert confirmed.our_version_status == "ready"

    assert undo(editor_client, recipe.id, batch).status_code == 200
    back = stored(api_store, recipe.id)
    assert [i.status for i in back.issues] == ["open"]
    assert back.our_version_status == "awaiting_review"


def test_an_our_version_line_asked_for_its_food_stays_flagged_when_confirmed(
    editor_client: TestClient, api_store: Store
) -> None:
    # A wording spread's ask proposes no correction: only an edit of the line settles it.
    asked = issue(1, "our_version.i1.match", before=None, after=None)
    matched = RecipeFacts(ingredients={"i1": IngredientFacts(match=FACTS.ingredients["i1"].match)})
    recipe = enriched(api_store, issues=(asked,), step_facts={})
    ours = recipe.our_version
    assert ours is not None
    api_store.update_recipe(
        recipe.model_copy(update={"our_version": ours.model_copy(update={"facts": matched})})
    )

    response = confirm(editor_client, stored(api_store, recipe.id), "our_version.i1.match")

    assert response.status_code == 200, response.text
    confirmed = stored(api_store, recipe.id)
    assert [i.status for i in confirmed.issues] == ["open"]
    assert confirmed.our_version is not None
    match = confirmed.our_version.facts.ingredients["i1"].match
    assert match is not None
    assert match.confirmed
    assert confirmed.our_version_status == "awaiting_review"


def test_undoing_after_a_step_edit_leaves_our_version_pending(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = enriched(api_store)
    paths = [f"our_version.{s}.{k}" for s in ("s2", "s5") for k in ("segments", "uses")]
    batch = confirm(editor_client, recipe, *paths).json()["confirm_batch"]
    edited = save(editor_client, stored(api_store, recipe.id), steps_draft(s5="Rest briefly."))
    assert edited.json()["our_version_status"] == "pending"
    assert stored(api_store, recipe.id).our_version_ready_batch is None

    assert undo(editor_client, recipe.id, batch).status_code == 200

    assert stored(api_store, recipe.id).our_version_status == "pending"


def test_undoing_a_stale_batch_leaves_a_pending_our_version_pending(
    editor_client: TestClient, api_store: Store
) -> None:
    # A Pending Our Version still naming the batch that once made it Ready.
    batch = "01K7Q0000000000000000000B9"
    confirmed = {**CONFIRMED, "confirm_batch": batch}
    recipe = enriched(
        api_store,
        status="pending",
        step_facts={"s2": segmented(BROWN, **confirmed)},
        our_version_ready_batch=batch,
    )

    response = undo(editor_client, recipe.id, batch)

    assert response.status_code == 200, response.text
    back = stored(api_store, recipe.id)
    assert back.our_version_status == "pending"
    assert back.our_version is not None
    assert back.our_version.facts.steps["s2"] == segmented(BROWN)


@pytest.mark.parametrize(
    ("draft", "status"),
    [
        ({"steps": lines(edit={"s2": {"text": BROWN}})}, "awaiting_review"),
        ({}, "ready"),
    ],
    ids=["a segmented step left", "no step left"],
)
def test_a_save_dropping_the_only_step_waiting_for_enrich_settles_its_status(
    editor_client: TestClient, api_store: Store, draft: dict[str, Any], status: EnrichmentStatus
) -> None:
    # s2 is segmented, s5 waits for enrich; the save drops s5.
    recipe = enriched(api_store, status="pending", step_facts={"s2": segmented(BROWN)})

    response = save(editor_client, recipe, draft)

    assert response.status_code == 200, response.text
    assert stored(api_store, recipe.id).our_version_status == status


def test_the_original_is_ready_while_our_version_has_items_left(
    editor_client: TestClient, api_store: Store
) -> None:
    facts = RecipeFacts(steps={"s1": StepFacts(uses=uses())})
    recipe = enriched(api_store, facts=facts, status="awaiting_review")
    api_store.update_recipe(recipe.model_copy(update={"status": "awaiting_review"}))

    response = confirm(editor_client, stored(api_store, recipe.id), "s1.uses")

    assert response.status_code == 200, response.text
    assert response.json()["ready"] is True
    confirmed = stored(api_store, recipe.id)
    assert (confirmed.status, confirmed.our_version_status) == ("ready", "awaiting_review")


def test_removing_our_version_forgets_the_batch_that_made_it_ready(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = enriched(api_store, our_version_ready_batch="01K7Q0000000000000000000B9")

    response = remove(editor_client, recipe)

    assert response.status_code == 200, response.text
    assert stored(api_store, recipe.id).our_version_ready_batch is None
