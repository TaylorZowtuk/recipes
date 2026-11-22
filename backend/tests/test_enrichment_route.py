"""The enrich CLI writes a Pending recipe's parse facts, which moves its Enrichment Status."""

import json
from typing import TYPE_CHECKING, Any, cast

import pytest
from conftest import EDITOR, SNAPSHOT

from recipes import fdc
from recipes.auth import SERVICE_TOKEN_HEADER
from recipes.ingest import BROWSER_EXTRACTOR, EXTRACTOR, LLM_EXTRACTOR, PASTED_EXTRACTOR
from recipes.models import (
    MAX_LABEL,
    MAX_RECIPE_BYTES,
    CanonicalIngredient,
    Enrichment,
    EnrichmentIssue,
    FdcNumbers,
    Per100g,
    Recipe,
    Step,
    Wording,
)
from recipes.seed import RECIPES
from recipes.store import MAX_LEARNED

if TYPE_CHECKING:
    from fastapi.testclient import TestClient
    from httpx2 import Response

    from recipes.store import Store

MISSING_ID = "01K7ZZZZZZZZZZZZZZZZZZZZZZ"
# The seed's one Pending recipe, whose lines are i1 to i9.
PENDING = next(recipe for recipe in RECIPES if recipe.status == "pending")
READY = next(recipe for recipe in RECIPES if recipe.status == "ready")

PARSER = {"provenance": "parser", "confidence": 0.9, "estimated": False}
FACTS = {
    "ingredients": {
        "i1": {
            "parse": {
                **PARSER,
                "quantity": {"low": 900, "high": 900},
                "unit": "g",
                "unit_kind": "mass",
                "name": "stewing beef",
                "preparation": "cubed",
            }
        },
        "i9": {
            "parse": {
                **PARSER,
                "confidence": 0.5,
                "quantity": None,
                "unit": None,
                "unit_kind": None,
                "name": "parsley",
                "short_name": "parsley",
                "preparation": "chopped",
                "optional": True,
            }
        },
    }
}


def add(store: Store, recipe: Recipe = PENDING, **fields: object) -> Recipe:
    return store.add_recipe(recipe.model_copy(update=fields))


def enrich(
    editor_client: TestClient,
    recipe_id: str,
    facts: dict[str, Any] = FACTS,
    headers: dict[str, str] = EDITOR,
) -> Response:
    body = {"enrichment_version": 1, "fdc_release": SNAPSHOT.release, "facts": facts}
    return editor_client.put(f"/api/recipes/{recipe_id}/enrichment", json=body, headers=headers)


def fetch(editor_client: TestClient, recipe_id: str) -> dict[str, Any]:
    return editor_client.get(f"/api/recipes/{recipe_id}", follow_redirects=True).json()


@pytest.mark.parametrize(
    ("channel", "status"),
    [("add_a_recipe", "awaiting_review"), ("bulk_import", "ready"), (None, "awaiting_review")],
)
def test_enriching_moves_a_pending_recipe_on_by_its_ingest_channel(
    editor_client: TestClient, api_store: Store, channel: str | None, status: str
) -> None:
    recipe = add(api_store, ingest_channel=channel)

    response = enrich(editor_client, recipe.id)

    assert response.status_code == 200
    assert response.json()["status"] == status
    assert response.json()["version"] == recipe.version + 1
    assert fetch(editor_client, recipe.id)["status"] == status


@pytest.mark.parametrize(
    ("channel", "extractor", "status"),
    [
        ("bulk_import", LLM_EXTRACTOR, "awaiting_review"),
        ("add_a_recipe", LLM_EXTRACTOR, "awaiting_review"),
        (None, LLM_EXTRACTOR, "awaiting_review"),
        ("bulk_import", EXTRACTOR, "ready"),
        ("bulk_import", BROWSER_EXTRACTOR, "ready"),
        ("bulk_import", PASTED_EXTRACTOR, "ready"),
    ],
)
def test_an_llm_extracted_original_always_stops_at_awaiting_review(
    editor_client: TestClient,
    api_store: Store,
    channel: str | None,
    extractor: str,
    status: str,
) -> None:
    original = PENDING.original.model_copy(update={"extractor": extractor})
    recipe = add(api_store, ingest_channel=channel, original=original)

    response = enrich(editor_client, recipe.id)

    assert response.status_code == 200
    assert response.json()["status"] == status


def test_the_facts_and_enrichment_version_are_stored_with_the_recipe(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = add(api_store, ingest_channel="add_a_recipe")

    enrich(editor_client, recipe.id)

    stored = fetch(editor_client, recipe.id)
    assert stored["enrichment_version"] == 1
    assert stored["original"] == recipe.original.model_dump(mode="json", by_alias=True)
    beef = stored["facts"]["ingredients"]["i1"]["parse"]
    assert beef["quantity"] == {"low": 900, "high": 900}
    assert (beef["unit"], beef["unit_kind"], beef["name"]) == ("g", "mass", "stewing beef")
    assert (beef["provenance"], beef["confidence"], beef["estimated"]) == ("parser", 0.9, False)
    assert (beef["confirmed"], beef["confirmed_by"], beef["confirmed_at"]) == (False, None, None)
    parsley = stored["facts"]["ingredients"]["i9"]["parse"]
    assert parsley["quantity"] is None
    assert parsley["optional"] is True


def test_the_card_shows_the_new_status(editor_client: TestClient, api_store: Store) -> None:
    recipe = add(api_store, ingest_channel="add_a_recipe")

    enrich(editor_client, recipe.id)

    cards = editor_client.get("/api/collection", follow_redirects=True).json()["cards"]
    card = next(card for card in cards if card["id"] == recipe.id)
    assert card["status"] == "awaiting_review"
    assert card["recipe_version"] == recipe.version + 1
    # Its two parsed lines are each a Review Item.
    assert card["needs_review"] == {"open_issues": 0, "unconfirmed": 2, "flagged": 0}


def test_a_fact_for_a_line_the_recipe_lacks_is_refused(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = add(api_store)
    facts = {"ingredients": {"i99": FACTS["ingredients"]["i1"]}}

    response = enrich(editor_client, recipe.id, facts)

    assert response.status_code == 422
    assert fetch(editor_client, recipe.id)["status"] == "pending"


def test_only_an_editor_can_enrich(editor_client: TestClient, api_store: Store) -> None:
    recipe = add(api_store)

    for headers in ({}, {SERVICE_TOKEN_HEADER: "wrong-token"}):
        response = enrich(editor_client, recipe.id, headers=headers)

        assert response.status_code == 403
    assert fetch(editor_client, recipe.id)["status"] == "pending"


def test_an_unknown_recipe_is_not_found(editor_client: TestClient) -> None:
    assert enrich(editor_client, MISSING_ID).status_code == 404


def with_beef(**fields: object) -> dict[str, Any]:
    """The facts, with the first line's parse fact changed."""
    beef = {**FACTS["ingredients"]["i1"]["parse"], **fields}
    return {"ingredients": {"i1": {"parse": beef}}}


@pytest.mark.parametrize(
    ("low", "high"),
    [(float("nan"), 1), (1, float("inf")), (-1, 1), (3, 2)],
    ids=["NaN", "Infinity", "negative", "downward"],
)
def test_a_quantity_that_isnt_an_upward_range_of_amounts_is_refused(
    editor_client: TestClient, api_store: Store, low: float, high: float
) -> None:
    recipe = add(api_store)
    # Sent as written, since JSON's own encoders refuse NaN and Infinity, and FastAPI reads them.
    body = {"enrichment_version": 1, "facts": with_beef(quantity={"low": low, "high": high})}

    response = editor_client.put(
        f"/api/recipes/{recipe.id}/enrichment",
        content=json.dumps(body),
        headers={**EDITOR, "content-type": "application/json"},
    )

    assert response.status_code == 422
    stored = editor_client.get(f"/api/recipes/{recipe.id}", follow_redirects=True)
    assert stored.status_code == 200
    assert stored.json()["status"] == "pending"


@pytest.mark.parametrize(
    "field",
    ["name", "short_name", "preparation", "comment", "unit", "confirmed_by", "confirm_batch"],
)
def test_a_fact_string_past_a_labels_limit_is_refused(
    editor_client: TestClient, api_store: Store, field: str
) -> None:
    recipe = add(api_store)

    response = enrich(editor_client, recipe.id, with_beef(**{field: "x" * (MAX_LABEL + 1)}))

    assert response.status_code == 422
    assert fetch(editor_client, recipe.id)["status"] == "pending"


# A Canonical Ingredient and its Wording, as the enrich CLI learns them from a model's answer.
BEEF_ID = "01K7Q0000000000000000000C1"
CHUCK_ID = "01K7Q0000000000000000000C2"
BEEF = {
    "id": BEEF_ID,
    "name": "stewing beef",
    "family": "beef",
    "store_category_id": "meat",
    "version": 1,
    "schema_version": 1,
}
LLM = {"provenance": "llm", "confidence": 0.8, "estimated": False}
MATCHED = {
    "ingredients": {
        "i1": {
            **FACTS["ingredients"]["i1"],
            "match": {**LLM, "canonical_id": BEEF_ID, "fdc_id": 1001, "portion_id": None},
        }
    }
}


def add_second(store: Store) -> Recipe:
    """Another Pending recipe, to enrich after the first."""
    return add(store, id="01K7Q0000000000000000000E1", dedupe_key="https://plateful.test/second")


def issue(n: int, status: str = "open") -> dict[str, Any]:
    return {
        "id": f"01K7Q0000000000000000000D{n}",
        "fact_id": "i1.match",
        "before": None,
        "after": "stewing beef",
        "reason": "New Canonical Ingredient stewing beef (beef, Meat)",
        "model": "a-model",
        "status": status,
        "confirm_batch": None,
    }


def enrich_matched(editor_client: TestClient, recipe_id: str, **fields: object) -> Response:
    body = {
        "enrichment_version": 2,
        "fdc_release": SNAPSHOT.release,
        "facts": MATCHED,
        "issues": [issue(1)],
        "canonical_ingredients": [BEEF],
        "wordings": [{"wording": "stewing beef", "canonical_id": BEEF_ID, "schema_version": 1}],
        **fields,
    }
    return editor_client.put(f"/api/recipes/{recipe_id}/enrichment", json=body, headers=EDITOR)


def bundle(editor_client: TestClient) -> dict[str, Any]:
    return editor_client.get("/api/collection", follow_redirects=True).json()


def test_a_match_writes_its_new_canonical_ingredient_and_wording_with_the_recipe(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = add(api_store)
    before = api_store.collection_version()

    response = enrich_matched(editor_client, recipe.id)

    assert response.status_code == 200
    stored = fetch(editor_client, recipe.id)
    assert stored["fdc_release"] == SNAPSHOT.release
    assert stored["issues"] == [issue(1)]
    assert stored["facts"]["ingredients"]["i1"]["match"]["canonical_id"] == BEEF_ID
    collection = bundle(editor_client)
    assert collection["collection_version"] == before + 1
    assert collection["canonical_ingredients"] == [
        {**BEEF, "pantry_staple": False, "confirmed": False, "confirm_batch": None}
    ]
    assert collection["wordings"] == [
        {
            "wording": "stewing beef",
            "canonical_id": BEEF_ID,
            "confirmed": False,
            "schema_version": 1,
        }
    ]


def test_a_match_may_name_an_existing_canonical_ingredient(
    editor_client: TestClient, api_store: Store
) -> None:
    enrich_matched(editor_client, add(api_store).id)
    second = add_second(api_store)

    response = enrich_matched(editor_client, second.id, canonical_ingredients=[])

    assert response.status_code == 200
    assert len(bundle(editor_client)["canonical_ingredients"]) == 1


def test_the_card_counts_the_open_issues_and_the_one_item_they_flag(
    editor_client: TestClient, api_store: Store
) -> None:
    issues = [
        EnrichmentIssue.model_validate(issue(n, status))
        for n, status in enumerate(["open", "resolved", "open"], 1)
    ]
    recipe = api_store.enrich_recipe(add(api_store).model_copy(update={"issues": issues}), [], [])

    card = next(card for card in bundle(editor_client)["cards"] if card["id"] == recipe.id)
    # Both open issues are on i1.match, which the recipe lacks: one item, left to check.
    assert card["needs_review"] == {"open_issues": 2, "unconfirmed": 1, "flagged": 1}


def assert_nothing_written(editor_client: TestClient, recipe: Recipe) -> None:
    assert fetch(editor_client, recipe.id) == recipe.model_dump(mode="json")
    collection = bundle(editor_client)
    assert (collection["canonical_ingredients"], collection["wordings"]) == ([], [])


@pytest.mark.parametrize(
    "fields",
    [
        {"canonical_ingredients": []},
        {"canonical_ingredients": [{**BEEF, "store_category_id": "no-such-category"}]},
        {"wordings": [{"wording": "stewing beef", "canonical_id": CHUCK_ID, "schema_version": 1}]},
    ],
    ids=["unknown match", "unknown store category", "wording for an unknown canonical"],
)
def test_an_unknown_canonical_ingredient_or_store_category_is_refused(
    editor_client: TestClient, api_store: Store, fields: dict[str, Any]
) -> None:
    recipe = add(api_store)

    response = enrich_matched(editor_client, recipe.id, **fields)

    assert response.status_code == 422
    assert_nothing_written(editor_client, recipe)


def test_a_confirmed_wording_is_never_overwritten(
    editor_client: TestClient, api_store: Store
) -> None:
    other = add(api_store, READY, status="pending")
    chuck = CanonicalIngredient.model_validate({**BEEF, "id": CHUCK_ID, "name": "chuck"})
    confirmed = Wording(
        wording="stewing beef", canonical_id=CHUCK_ID, confirmed=True, schema_version=1
    )
    api_store.enrich_recipe(other, [chuck], [confirmed])
    recipe = add(api_store)
    before = bundle(editor_client)

    response = enrich_matched(editor_client, recipe.id)

    assert response.status_code == 409
    assert fetch(editor_client, recipe.id) == recipe.model_dump(mode="json")
    after = bundle(editor_client)
    assert after["collection_version"] == before["collection_version"]
    assert after["canonical_ingredients"] == before["canonical_ingredients"]
    assert after["wordings"] == before["wordings"]


def test_an_unconfirmed_wording_is_learned_again(
    editor_client: TestClient, api_store: Store
) -> None:
    enrich_matched(editor_client, add(api_store).id)
    second = add_second(api_store)
    chuck = {**BEEF, "id": "01K7Q0000000000000000000C3", "name": "chuck"}

    response = enrich_matched(
        editor_client,
        second.id,
        canonical_ingredients=[chuck],
        wordings=[{"wording": "Stewing  Beef.", "canonical_id": chuck["id"], "schema_version": 1}],
    )

    assert response.status_code == 200
    wordings = bundle(editor_client)["wordings"]
    assert [(w["wording"], w["canonical_id"]) for w in wordings] == [("stewing beef", chuck["id"])]


def test_a_canonical_ingredient_that_exists_is_not_created_again(
    editor_client: TestClient, api_store: Store
) -> None:
    enrich_matched(editor_client, add(api_store).id)
    second = add_second(api_store)
    before = bundle(editor_client)

    response = enrich_matched(
        editor_client,
        second.id,
        canonical_ingredients=[{**BEEF, "name": "beef"}],
        wordings=[{"wording": "stewing beef", "canonical_id": BEEF_ID, "schema_version": 1}],
    )

    assert response.status_code == 409
    assert fetch(editor_client, second.id)["status"] == "pending"
    after = bundle(editor_client)
    assert after["canonical_ingredients"] == before["canonical_ingredients"]
    assert after["wordings"] == before["wordings"]


@pytest.mark.parametrize(
    "fields",
    [
        {"canonical_ingredients": [{**BEEF, "confirmed": True}]},
        {
            "wordings": [
                {
                    "wording": "stewing beef",
                    "canonical_id": BEEF_ID,
                    "confirmed": True,
                    "schema_version": 1,
                }
            ]
        },
    ],
    ids=["confirmed canonical", "confirmed wording"],
)
def test_enrichment_cant_confirm_what_it_learns(
    editor_client: TestClient, api_store: Store, fields: dict[str, Any]
) -> None:
    recipe = add(api_store)

    response = enrich_matched(editor_client, recipe.id, **fields)

    assert response.status_code == 422
    assert_nothing_written(editor_client, recipe)


@pytest.mark.parametrize(
    "fact_id",
    ["i10.match", "i1.segments", "i1", "s9.segments", "s1.parse"],
    ids=["no such line", "no such fact", "no fact", "no such step", "no such step fact"],
)
def test_an_issue_on_a_fact_enrichment_doesnt_write_is_refused(
    editor_client: TestClient, api_store: Store, fact_id: str
) -> None:
    recipe = add(api_store)

    response = enrich_matched(editor_client, recipe.id, issues=[{**issue(1), "fact_id": fact_id}])

    assert response.status_code == 422
    assert_nothing_written(editor_client, recipe)


def test_an_enrichment_learning_more_than_a_transaction_holds_is_refused(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = add(api_store)
    wording = {"wording": "stewing beef", "canonical_id": BEEF_ID, "schema_version": 1}
    news = [{**BEEF, "id": f"01K7Q00000000000000000{n:04d}"} for n in range(MAX_LEARNED)]

    response = enrich_matched(
        editor_client, recipe.id, canonical_ingredients=news, wordings=[wording]
    )

    assert response.status_code == 422
    assert "at most" in response.json()["detail"]
    assert_nothing_written(editor_client, recipe)


def test_an_enrichment_with_more_than_200_issues_is_refused(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = add(api_store)
    issues = [{**issue(1), "id": f"01K7Q00000000000000000{n:04d}"} for n in range(201)]

    response = enrich_matched(editor_client, recipe.id, issues=issues)

    assert response.status_code == 422
    assert_nothing_written(editor_client, recipe)


def test_an_enrichment_too_big_for_one_item_is_refused(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = add(api_store)
    issues = [
        {**issue(1), "id": f"01K7Q00000000000000000{n:04d}", "reason": "x" * 2000}
        for n in range(200)
    ]

    response = enrich_matched(editor_client, recipe.id, issues=issues)

    assert response.status_code == 422
    assert f"at most {MAX_RECIPE_BYTES} bytes" in response.json()["detail"]
    assert_nothing_written(editor_client, recipe)


@pytest.mark.parametrize(
    "fields",
    [
        {"wordings": [{"wording": "salt", "canonical_id": BEEF_ID, "schema_version": 1}]},
        {"wordings": [{"wording": "cubed", "canonical_id": BEEF_ID, "schema_version": 1}]},
        {"issues": [issue(1, "resolved")]},
        {"issues": [{**issue(1), "confirm_batch": "batch-1"}]},
    ],
    ids=["wording of no line", "wording of no line's name", "resolved issue", "confirmed issue"],
)
def test_a_wording_of_another_line_or_an_issue_already_settled_is_refused(
    editor_client: TestClient, api_store: Store, fields: dict[str, Any]
) -> None:
    recipe = add(api_store)

    response = enrich_matched(editor_client, recipe.id, **fields)

    assert response.status_code == 422
    assert_nothing_written(editor_client, recipe)


def beef(portion: float, ref: str = "i1") -> list[dict[str, Any]]:
    """s1's segments, naming the beef as the line `ref` with `portion`."""
    return [
        {"t": "text", "v": "Toss the "},
        {"t": "ingredient", "ref": ref, "written": "beef", "portion": portion},
        {"t": "text", "v": " in flour and brown it in the oil in batches."},
    ]


def simmer(*timer: dict[str, Any]) -> list[dict[str, Any]]:
    """s3's segments, with `timer` in place of "1 1/2 hours" and the text before it."""
    return [*timer, {"t": "text", "v": "."}]


SIMMER_TIMER = (
    {"t": "text", "v": "Add the stock and barley, cover and simmer "},
    {"t": "duration", "low_s": 5400, "high_s": 5400, "written": "1 1/2 hours"},
)
STEPPED = {
    "ingredients": FACTS["ingredients"],
    "steps": {
        "s1": {
            "segments": {**LLM, "segments": beef(0.5)},
            "uses": {**LLM, "estimated": True, "uses": [{"ref": "i1", "portion": 0.5}]},
        },
        # A step may use a line without naming it.
        "s2": {"uses": {**LLM, "estimated": True, "uses": [{"ref": "i1", "portion": 0.5}]}},
        "s3": {"segments": {**LLM, "segments": simmer(*SIMMER_TIMER)}},
    },
}


def stepped(
    segments: list[dict[str, Any]] | None = None,
    uses: list[dict[str, Any]] | None = None,
    s3: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """The step facts, with s1's segments or uses, or s3's segments, changed."""
    steps = STEPPED["steps"]
    s1 = steps["s1"]
    return {
        **STEPPED,
        "steps": {
            **steps,
            "s1": {
                "segments": {**s1["segments"], "segments": segments or s1["segments"]["segments"]},
                "uses": {**s1["uses"], "uses": s1["uses"]["uses"] if uses is None else uses},
            },
            "s3": {"segments": {**steps["s3"]["segments"], "segments": s3}} if s3 else steps["s3"],
        },
    }


def use(ref: str, portion: float) -> dict[str, Any]:
    return {"ref": ref, "portion": portion}


def test_step_facts_are_stored_with_the_recipe(editor_client: TestClient, api_store: Store) -> None:
    recipe = add(api_store)

    response = enrich(editor_client, recipe.id, STEPPED)

    assert response.status_code == 200
    stored = fetch(editor_client, recipe.id)
    assert stored["original"]["steps"] == recipe.original.model_dump(mode="json")["steps"]
    toss = stored["facts"]["steps"]["s1"]
    assert toss["segments"]["segments"][1] == {
        "t": "ingredient",
        "ref": "i1",
        "written": "beef",
        "portion": 0.5,
    }
    assert stored["facts"]["steps"]["s3"]["segments"]["segments"][1] == {
        "t": "duration",
        "low_s": 5400,
        "high_s": 5400,
        "written": "1 1/2 hours",
    }
    assert stored["facts"]["steps"]["s2"]["segments"] is None
    assert stored["facts"]["steps"]["s2"]["uses"]["uses"] == [{"ref": "i1", "portion": 0.5}]
    assert sorted(stored["facts"]["steps"]) == ["s1", "s2", "s3"]


def test_a_lines_portions_adding_up_to_all_of_it_are_accepted(
    editor_client: TestClient, api_store: Store
) -> None:
    # Nine ninths add up to a little more than 1 in floating point.
    steps = [Step(id=f"s{n}", text="Season the beef.") for n in range(1, 10)]
    recipe = add(api_store, original=PENDING.original.model_copy(update={"steps": steps}))
    season = {
        "segments": {
            **LLM,
            "segments": [
                {"t": "text", "v": "Season the "},
                {"t": "ingredient", "ref": "i1", "written": "beef", "portion": 1 / 9},
                {"t": "text", "v": "."},
            ],
        },
        "uses": {**LLM, "estimated": True, "uses": [use("i1", 1 / 9)]},
    }
    facts = {**STEPPED, "steps": {step.id: season for step in steps}}

    response = enrich(editor_client, recipe.id, facts)

    assert response.status_code == 200


@pytest.mark.parametrize(
    ("facts", "detail"),
    [
        ({**STEPPED, "steps": {"s9": STEPPED["steps"]["s1"]}}, "no step s9"),
        (stepped(uses=[use("i99", 0.5)]), "no line i99"),
        (stepped(beef(0.5, "i99")), "no line i99"),
        (
            stepped([{"t": "text", "v": "Toss the beef in flour."}], []),
            "Step s1's segments aren't its text",
        ),
        (stepped(beef(0.75), [use("i1", 0.75)]), "The steps use more than all of i1"),
        (stepped(uses=[use("i1", 1.5)]), "less than or equal to 1"),
        (stepped(uses=[use("i1", 0)]), "greater than 0"),
        (stepped(beef(1.5), [use("i1", 1.5)]), "less than or equal to 1"),
        (stepped(uses=[use("i1", 0.25), use("i1", 0.25)]), "Step s1 uses i1 twice"),
        (stepped(uses=[]), "Step s1's uses aren't its ingredient segments' portions"),
        (
            stepped(uses=[use("i1", 0.25)]),
            "Step s1's uses aren't its ingredient segments' portions",
        ),
        (
            stepped(uses=[use("i1", 0.5), use("i9", 0.5)]),
            "Step s1's uses aren't its ingredient segments' portions",
        ),
        (
            stepped(s3=simmer({**SIMMER_TIMER[0]}, {**SIMMER_TIMER[1], "low_s": 5, "high_s": 5})),
            "Step s3's 1 1/2 hours isn't what code finds there",
        ),
        (
            stepped(
                s3=simmer(
                    {"t": "text", "v": "Add the stock and barley, cover and simmer 1 "},
                    {"t": "duration", "low_s": 1800, "high_s": 1800, "written": "1/2 hours"},
                )
            ),
            "Step s3's 1/2 hours isn't what code finds there",
        ),
        (
            stepped(
                s3=simmer(
                    {**SIMMER_TIMER[0]},
                    {"t": "temperature", "c": 90, "written": "1 1/2 hours"},
                )
            ),
            "Step s3's 1 1/2 hours isn't what code finds there",
        ),
    ],
    ids=[
        "no such step",
        "uses no such line",
        "segment of no such line",
        "segments that aren't the text",
        "portions over 1 across steps",
        "portion over 1",
        "zero portion",
        "segment portion over 1",
        "a line used twice in a step",
        "segment with no use",
        "use that isn't its segments' portion",
        "use with no segment",
        "duration with another number",
        "duration code finds elsewhere",
        "temperature code doesn't find",
    ],
)
def test_step_facts_that_dont_fit_the_recipe_are_refused(
    editor_client: TestClient, api_store: Store, facts: dict[str, Any], detail: str
) -> None:
    recipe = add(api_store)

    response = enrich(editor_client, recipe.id, facts)

    assert response.status_code == 422
    assert detail in str(response.json()["detail"])
    assert fetch(editor_client, recipe.id)["status"] == "pending"


@pytest.mark.parametrize("fact_id", ["s1.segments", "s4.uses"])
def test_an_issue_on_a_steps_fact_is_accepted(
    editor_client: TestClient, api_store: Store, fact_id: str
) -> None:
    recipe = add(api_store)

    response = enrich_matched(editor_client, recipe.id, issues=[{**issue(1), "fact_id": fact_id}])

    assert response.status_code == 200


CHUCK = {**BEEF, "id": CHUCK_ID, "name": "beef chuck"}
SUGGESTION = {"provenance": "llm", "confidence": 0.6, "estimated": True}
SWAP = {
    "wording": "beef chuck",
    "canonical_id": CHUCK_ID,
    "ratio": 1,
    "note": "simmer a little longer",
    "fdc_id": 1002,
    "portion_id": None,
}


def numbers(fdc_id: int, portion_id: int | None) -> dict[str, Any]:
    """The fixture FDC Snapshot's numbers for a food and FDC portion, as the API stores them."""
    return fdc.numbers(SNAPSHOT, fdc_id, portion_id).model_dump(mode="json")


def suggesting(
    substitutions: dict[str, Any] | None = None, difficulty: dict[str, Any] | None = None
) -> dict[str, Any]:
    """The matched facts, with substitutions for the beef and a suggested Difficulty, each
    changed by its fields.
    """
    beef = MATCHED["ingredients"]["i1"]
    return {
        "ingredients": {
            "i1": {
                **beef,
                "substitutions": {**SUGGESTION, "items": [SWAP], **(substitutions or {})},
            }
        },
        "difficulty": {**SUGGESTION, "prep": 1, "cook": 2, "cleanup": 3, **(difficulty or {})},
    }


def test_substitutions_and_a_suggested_difficulty_are_stored_with_the_recipe(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = add(api_store)
    facts = suggesting()

    response = enrich_matched(
        editor_client, recipe.id, facts=facts, canonical_ingredients=[BEEF, CHUCK]
    )

    assert response.status_code == 200
    stored = fetch(editor_client, recipe.id)["facts"]
    swap = stored["ingredients"]["i1"]["substitutions"]
    assert swap.pop("items") == [{**SWAP, "fdc": numbers(1002, None)}]
    sent = {k: v for k, v in facts["ingredients"]["i1"]["substitutions"].items() if k != "items"}
    assert swap == sent | UNCONFIRMED
    assert stored["difficulty"] == {**SUGGESTION, "prep": 1, "cook": 2, "cleanup": 3} | {
        "confirmed": False,
        "confirmed_by": None,
        "confirmed_at": None,
        "confirm_batch": None,
    }
    card = next(card for card in bundle(editor_client)["cards"] if card["id"] == recipe.id)
    assert card["difficulty"] == {"prep": 1, "cook": 2, "cleanup": 3}
    assert card["difficulty_suggested"] is True


UNVOUCHED = "Substitutions and a suggested Difficulty arrive as the LLM's unconfirmed estimate"
CONFIRMED_AT = "2026-10-01T12:00:00Z"


@pytest.mark.parametrize(
    ("facts", "canonicals", "detail"),
    [
        (suggesting(substitutions={"confirmed": True}), [BEEF, CHUCK], UNVOUCHED),
        (suggesting(difficulty={"confirmed": True}), [BEEF, CHUCK], UNVOUCHED),
        (suggesting(difficulty={"confirm_batch": "batch-1"}), [BEEF, CHUCK], UNVOUCHED),
        (
            suggesting(substitutions={"confirmed_by": "editor"}),
            [BEEF, CHUCK],
            UNVOUCHED,
        ),
        (suggesting(difficulty={"confirmed_by": "editor"}), [BEEF, CHUCK], UNVOUCHED),
        (suggesting(difficulty={"confirmed_at": CONFIRMED_AT}), [BEEF, CHUCK], UNVOUCHED),
        (suggesting(substitutions={"provenance": "fdc"}), [BEEF, CHUCK], UNVOUCHED),
        (suggesting(difficulty={"provenance": "editor"}), [BEEF, CHUCK], UNVOUCHED),
        (suggesting(difficulty={"estimated": False}), [BEEF, CHUCK], UNVOUCHED),
        (suggesting(substitutions={"estimated": False}), [BEEF, CHUCK], UNVOUCHED),
        (suggesting(), [BEEF], f"No Canonical Ingredient {CHUCK_ID}"),
        (
            suggesting(substitutions={"items": [{**SWAP, "canonical_id": BEEF_ID}]}),
            [BEEF],
            "A substitute isn't its line's own Canonical Ingredient",
        ),
    ],
    ids=[
        "confirmed substitutions",
        "confirmed difficulty",
        "difficulty in a Confirm Batch",
        "substitutions confirmed by an editor",
        "difficulty confirmed by an editor",
        "difficulty confirmed at a time",
        "substitutions not from the LLM",
        "difficulty not from the LLM",
        "difficulty not estimated",
        "substitutions not estimated",
        "unknown substitute",
        "substitute is the line's own match",
    ],
)
def test_substitutions_or_a_difficulty_enrichment_cant_vouch_for_are_refused(
    editor_client: TestClient,
    api_store: Store,
    facts: dict[str, Any],
    canonicals: list[dict[str, Any]],
    detail: str,
) -> None:
    recipe = add(api_store)

    response = enrich_matched(
        editor_client, recipe.id, facts=facts, canonical_ingredients=canonicals
    )

    assert response.status_code == 422
    assert response.json()["detail"] == detail
    assert_nothing_written(editor_client, recipe)


def test_a_line_with_more_than_five_substitutes_is_refused(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = add(api_store)
    swaps = [{**SWAP, "wording": f"beef chuck {n}"} for n in range(6)]

    response = enrich_matched(
        editor_client,
        recipe.id,
        facts=suggesting(substitutions={"items": swaps}),
        canonical_ingredients=[BEEF, CHUCK],
    )

    assert response.status_code == 422
    assert "items" in str(response.json()["detail"])
    assert_nothing_written(editor_client, recipe)


@pytest.mark.parametrize("fact_id", ["difficulty", "i1.substitutions"])
def test_an_issue_on_a_suggestion_is_accepted(
    editor_client: TestClient, api_store: Store, fact_id: str
) -> None:
    recipe = add(api_store)

    response = enrich_matched(
        editor_client,
        recipe.id,
        facts=suggesting(),
        canonical_ingredients=[BEEF, CHUCK],
        issues=[{**issue(1), "fact_id": fact_id}],
    )

    assert response.status_code == 200


UNCONFIRMED = {
    "confirmed": False,
    "confirmed_by": None,
    "confirmed_at": None,
    "confirm_batch": None,
}


def test_the_api_fills_in_the_fdc_numbers_from_its_own_fdc_snapshot(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = add(api_store)
    facts = suggesting()
    facts["ingredients"]["i2"] = {
        "match": {
            **LLM,
            "confidence": 0.7,
            "canonical_id": BEEF_ID,
            "fdc_id": 1001,
            "portion_id": 501,
        }
    }

    response = enrich_matched(
        editor_client, recipe.id, facts=facts, canonical_ingredients=[BEEF, CHUCK]
    )

    assert response.status_code == 200
    stored = fetch(editor_client, recipe.id)
    assert stored["fdc_release"] == SNAPSHOT.release
    lines = stored["facts"]["ingredients"]
    for line_id, portion_id, confidence in [("i1", None, 0.8), ("i2", 501, 0.7)]:
        assert lines[line_id]["conversion"] == {
            "provenance": "fdc",
            "confidence": confidence,
            "estimated": True,
            **UNCONFIRMED,
            "fdc_id": 1001,
            **numbers(1001, portion_id),
        }
    assert lines["i1"]["conversion"]["refused"] == fdc.NO_PORTION
    assert lines["i1"]["substitutions"]["items"] == [{**SWAP, "fdc": numbers(1002, None)}]


def matched_to(fdc_id: int, portion_id: int | None) -> dict[str, Any]:
    facts = suggesting()
    match = facts["ingredients"]["i1"]["match"]
    facts["ingredients"]["i1"]["match"] = {**match, "fdc_id": fdc_id, "portion_id": portion_id}
    return facts


OTHER_RELEASE = "foundation-2026-04-30+sr_legacy-2018-04"


@pytest.mark.parametrize(
    ("fields", "detail"),
    [
        (
            {"fdc_release": OTHER_RELEASE},
            (
                f"Enriched against release {OTHER_RELEASE}, the API has {SNAPSHOT.release}: "
                "pull and enrich again"
            ),
        ),
        ({"facts": matched_to(9999, None)}, "Line i1: FDC food 9999 isn't in the FDC Snapshot"),
        ({"facts": matched_to(1001, 503)}, "Line i1: portion 503 isn't one of FDC food 1001's"),
        (
            {"facts": suggesting(substitutions={"items": [{**SWAP, "fdc_id": 9999}]})},
            "Line i1's substitute beef chuck: FDC food 9999 isn't in the FDC Snapshot",
        ),
        (
            {"facts": suggesting(substitutions={"items": [{**SWAP, "portion_id": 501}]})},
            "Line i1's substitute beef chuck: portion 501 isn't one of FDC food 1002's",
        ),
    ],
)
def test_another_release_or_an_fdc_food_or_portion_not_in_the_snapshot_is_refused(
    editor_client: TestClient, api_store: Store, fields: dict[str, Any], detail: str
) -> None:
    recipe = add(api_store)

    response = enrich_matched(
        editor_client, recipe.id, canonical_ingredients=[BEEF, CHUCK], **fields
    )

    assert response.status_code == 422
    assert response.json()["detail"] == detail
    assert_nothing_written(editor_client, recipe)


def test_a_missing_fdc_release_is_refused(editor_client: TestClient, api_store: Store) -> None:
    recipe = add(api_store)
    body = {
        "enrichment_version": 2,
        "facts": MATCHED,
        "issues": [issue(1)],
        "canonical_ingredients": [BEEF],
        "wordings": [],
    }

    response = editor_client.put(f"/api/recipes/{recipe.id}/enrichment", json=body, headers=EDITOR)

    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", "fdc_release"]
    assert_nothing_written(editor_client, recipe)


def test_an_old_clients_conversion_and_fdc_numbers_are_ignored(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = add(api_store)
    sent = suggesting()
    line = sent["ingredients"]["i1"]
    kcal = {"kcal": 999.0}
    line["conversion"] = {
        "provenance": "fdc",
        "confidence": 0.9,
        "estimated": True,
        "confirmed": True,
        "fdc_id": 1001,
        **numbers(1001, None),
        "per_100g": {**numbers(1001, None)["per_100g"], **kcal},
    }
    line["substitutions"]["items"] = [{**SWAP, "fdc": {**numbers(1002, None), "per_100g": kcal}}]

    response = enrich_matched(
        editor_client, recipe.id, facts=sent, canonical_ingredients=[BEEF, CHUCK]
    )

    assert response.status_code == 200
    stored = fetch(editor_client, recipe.id)["facts"]["ingredients"]["i1"]
    assert {k: stored["conversion"][k] for k in ("per_100g", "density_g_per_ml")} == {
        k: numbers(1001, None)[k] for k in ("per_100g", "density_g_per_ml")
    }
    assert stored["conversion"]["confirmed"] is False
    assert stored["substitutions"]["items"] == [{**SWAP, "fdc": numbers(1002, None)}]


def test_the_enrichment_request_carries_no_fdc_numbers() -> None:
    schema = Enrichment.model_json_schema()
    properties: set[str] = set()

    def walk(node: object) -> None:
        if isinstance(node, dict):
            properties.update(cast("dict[str, Any]", node).get("properties", {}))
            for value in cast("dict[str, Any]", node).values():
                walk(value)
        elif isinstance(node, list):
            for value in cast("list[Any]", node):
                walk(value)

    walk(schema)
    fdc_fields = (
        {"conversion", "fdc"} | FdcNumbers.model_fields.keys() | Per100g.model_fields.keys()
    )
    assert properties.isdisjoint(fdc_fields)
    assert schema["$defs"].keys().isdisjoint({"FdcNumbers", "Per100g", "ConversionFact"})


# Re-enrichment: a recipe enriched with FIRST, reviewed, then enriched again with SECOND.
FIRST = {
    **suggesting(),
    "ingredients": {**suggesting()["ingredients"], "i9": FACTS["ingredients"]["i9"]},
    "steps": {"s1": STEPPED["steps"]["s1"], "s2": STEPPED["steps"]["s2"]},
}
SECOND = {
    "ingredients": {
        "i1": {
            "parse": {**FACTS["ingredients"]["i1"]["parse"], "name": "beef"},
            "match": {
                **LLM,
                "confidence": 0.7,
                "canonical_id": BEEF_ID,
                "fdc_id": 1001,
                "portion_id": 501,
            },
        },
        "i9": {"parse": {**FACTS["ingredients"]["i9"]["parse"], "name": "flat-leaf parsley"}},
    },
    "steps": {
        "s1": {
            "segments": {**LLM, "segments": beef(0.25)},
            "uses": {**LLM, "estimated": True, "uses": [use("i1", 0.25)]},
        },
        "s2": {"uses": {**LLM, "estimated": True, "uses": [use("i1", 0.25)]}},
    },
    "difficulty": {**SUGGESTION, "prep": 3, "cook": 3, "cleanup": 3},
}
CONFIRMED = {
    "confirmed": True,
    "confirmed_by": "editor@example.com",
    "confirmed_at": CONFIRMED_AT,
    "confirm_batch": "batch-1",
}


def reviewed(
    editor_client: TestClient,
    api_store: Store,
    *confirmed: str,
    status: str = "ready",
    issues: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """A recipe enriched with FIRST against another release, then reviewed: each fact in
    `confirmed` Confirmed, at `status`, with `issues`. Returns it as the API sends it.
    """
    recipe = add(api_store)
    enrich_matched(
        editor_client, recipe.id, facts=FIRST, canonical_ingredients=[BEEF, CHUCK], issues=[]
    )
    stored = fetch(editor_client, recipe.id)
    facts = stored["facts"]
    for path in confirmed:
        owner, _, kind = path.partition(".")
        holders = facts["ingredients"] if owner.startswith("i") else facts["steps"]
        (facts["difficulty"] if path == "difficulty" else holders[owner][kind]).update(CONFIRMED)
    stored |= {
        "status": status,
        "ready_batch": "batch-1" if status == "ready" else None,
        "issues": issues or [],
        "fdc_release": OTHER_RELEASE,
    }
    api_store.enrich_recipe(Recipe.model_validate(stored), [], [])
    return fetch(editor_client, recipe.id)


def reenrich(
    editor_client: TestClient,
    recipe_id: str,
    facts: dict[str, Any] = SECOND,
    *,
    version: int | None,
    dry_run: bool = False,
    **fields: object,
) -> Response:
    body = {"enrichment_version": 3, "fdc_release": SNAPSHOT.release, "facts": facts, **fields}
    params = {"dry_run": "true"} if dry_run else {}
    return editor_client.put(
        f"/api/recipes/{recipe_id}/enrichment",
        json=body,
        headers=EDITOR,
        params=params if version is None else {**params, "version": str(version)},
    )


def test_reenrichment_leaves_confirmed_facts_unchanged_and_updates_the_rest(
    editor_client: TestClient, api_store: Store
) -> None:
    before = reviewed(editor_client, api_store, "i1.parse", "s1.segments", "s1.uses", "difficulty")

    response = reenrich(editor_client, before["id"], version=before["version"])

    assert response.status_code == 200
    stored = fetch(editor_client, before["id"])
    assert response.json() == stored
    assert (stored["status"], stored["ready_batch"]) == ("ready", "batch-1")
    assert (stored["enrichment_version"], stored["fdc_release"]) == (3, SNAPSHOT.release)
    lines, was = stored["facts"]["ingredients"], before["facts"]["ingredients"]
    # The line's parse is Confirmed, so its match and conversion stay too.
    for kind in ("parse", "match", "conversion"):
        assert lines["i1"][kind] == was["i1"][kind]
    # Its substitutions are a Review Item of their own, unconfirmed: SECOND has none.
    assert lines["i1"]["substitutions"] is None
    assert lines["i9"]["parse"]["name"] == "flat-leaf parsley"
    assert stored["facts"]["steps"]["s1"] == before["facts"]["steps"]["s1"]
    assert stored["facts"]["steps"]["s2"]["uses"]["uses"] == [use("i1", 0.25)]
    assert stored["facts"]["difficulty"] == before["facts"]["difficulty"]


def test_a_review_item_with_one_confirmed_fact_is_kept_whole(
    editor_client: TestClient, api_store: Store
) -> None:
    before = reviewed(editor_client, api_store, "i1.match", "s1.uses")

    response = reenrich(editor_client, before["id"], version=before["version"])

    assert response.status_code == 200
    facts, was = response.json()["facts"], before["facts"]
    assert facts["ingredients"]["i1"]["parse"] == was["ingredients"]["i1"]["parse"]
    assert facts["ingredients"]["i1"]["parse"]["name"] == "stewing beef"
    assert facts["steps"]["s1"] == was["steps"]["s1"]
    assert facts["difficulty"]["prep"] == 3


@pytest.mark.parametrize("confirmed", [True, False])
def test_a_step_the_answer_leaves_out_is_kept_only_if_it_has_a_confirmed_fact(
    editor_client: TestClient, api_store: Store, *, confirmed: bool
) -> None:
    before = reviewed(editor_client, api_store, *(["s2.uses"] if confirmed else []))
    without_s2 = {**SECOND, "steps": {"s1": SECOND["steps"]["s1"]}}

    response = reenrich(editor_client, before["id"], without_s2, version=before["version"])

    assert response.status_code == 200
    steps = fetch(editor_client, before["id"])["facts"]["steps"]
    if confirmed:
        assert steps["s2"] == before["facts"]["steps"]["s2"]
    else:
        assert "s2" not in steps


def test_reenrichment_keeps_the_issues_on_kept_items_and_adds_those_on_replaced_ones(
    editor_client: TestClient, api_store: Store
) -> None:
    dropped = {**issue(1), "fact_id": "i9.parse"}
    resolved = {**issue(2, "resolved"), "fact_id": "i9.parse"}
    kept = issue(3)  # on i1.match, kept with its Confirmed parse
    before = reviewed(
        editor_client, api_store, "i1.parse", "s1.uses", issues=[dropped, resolved, kept]
    )
    added = {**issue(4), "fact_id": "i9.parse"}
    ignored = {**issue(5), "fact_id": "s1.segments"}

    response = reenrich(
        editor_client, before["id"], version=before["version"], issues=[added, ignored]
    )

    assert response.status_code == 200
    assert fetch(editor_client, before["id"])["issues"] == [resolved, kept, added]


def test_reenriching_a_recipe_awaiting_review_leaves_it_awaiting_review(
    editor_client: TestClient, api_store: Store
) -> None:
    before = reviewed(editor_client, api_store, "i1.parse", status="awaiting_review")

    response = reenrich(editor_client, before["id"], version=before["version"])

    assert response.status_code == 200
    assert (response.json()["status"], response.json()["ready_batch"]) == ("awaiting_review", None)


def test_reenrichment_that_uses_more_than_all_of_a_line_with_the_kept_steps_is_refused(
    editor_client: TestClient, api_store: Store
) -> None:
    # The kept s1 uses half the beef; SECOND's s1 a quarter, so its s2 may use three quarters.
    before = reviewed(editor_client, api_store, "s1.uses")
    facts = {
        **SECOND,
        "steps": {**SECOND["steps"], "s2": {"uses": {**LLM, "uses": [use("i1", 0.75)]}}},
    }

    response = reenrich(editor_client, before["id"], facts, version=before["version"])

    assert response.status_code == 422
    assert "The steps use more than all of i1" in response.json()["detail"]
    assert fetch(editor_client, before["id"]) == before


def test_reenrichment_matching_a_line_to_its_kept_substitute_is_refused(
    editor_client: TestClient, api_store: Store
) -> None:
    before = reviewed(editor_client, api_store, "i1.substitutions")
    chuck = {**LLM, "canonical_id": CHUCK_ID, "fdc_id": 1002, "portion_id": None}
    facts = {"ingredients": {"i1": {"match": chuck}}}

    response = reenrich(editor_client, before["id"], facts, version=before["version"])

    assert response.status_code == 422
    assert "A substitute isn't its line's own Canonical Ingredient" in response.json()["detail"]
    assert fetch(editor_client, before["id"]) == before


def test_a_dry_run_returns_the_reenriched_recipe_and_writes_nothing(
    editor_client: TestClient, api_store: Store
) -> None:
    before = reviewed(editor_client, api_store, "i1.parse")
    collection = bundle(editor_client)
    wording = {"wording": "flat-leaf parsley", "canonical_id": CHUCK_ID, "schema_version": 1}
    new = {**BEEF, "id": "01K7Q0000000000000000000C3", "name": "parsley"}

    response = reenrich(
        editor_client,
        before["id"],
        version=before["version"],
        dry_run=True,
        wordings=[wording],
        canonical_ingredients=[new],
    )

    assert response.status_code == 200
    would = response.json()
    assert would["version"] == before["version"] + 1
    assert would["facts"]["ingredients"]["i9"]["parse"]["name"] == "flat-leaf parsley"
    assert (
        would["facts"]["ingredients"]["i1"]["parse"]
        == before["facts"]["ingredients"]["i1"]["parse"]
    )
    assert fetch(editor_client, before["id"]) == before
    assert bundle(editor_client) == collection


def test_a_dry_run_of_a_pending_recipe_writes_nothing(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = add(api_store, ingest_channel="add_a_recipe")

    response = reenrich(editor_client, recipe.id, FACTS, version=None, dry_run=True)

    assert response.status_code == 200
    assert response.json()["status"] == "awaiting_review"
    assert fetch(editor_client, recipe.id) == recipe.model_dump(mode="json")


@pytest.mark.parametrize("dry_run", [False, True])
def test_reenriching_without_the_recipes_version_is_refused(
    editor_client: TestClient, api_store: Store, *, dry_run: bool
) -> None:
    before = reviewed(editor_client, api_store, "i1.parse")

    response = reenrich(editor_client, before["id"], version=None, dry_run=dry_run)

    assert response.status_code == 409
    assert "pass the version" in response.json()["detail"]
    assert fetch(editor_client, before["id"]) == before


@pytest.mark.parametrize("dry_run", [False, True])
def test_reenriching_a_recipe_changed_since_its_version_is_refused(
    editor_client: TestClient, api_store: Store, *, dry_run: bool
) -> None:
    before = reviewed(editor_client, api_store, "i1.parse")

    response = reenrich(editor_client, before["id"], version=before["version"] - 1, dry_run=dry_run)

    assert response.status_code == 409
    assert "changed since" in response.json()["detail"]
    assert fetch(editor_client, before["id"]) == before


def test_a_pending_recipe_may_be_enriched_at_its_version(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = add(api_store, ingest_channel="add_a_recipe")

    stale = reenrich(editor_client, recipe.id, FACTS, version=recipe.version + 1)
    response = reenrich(editor_client, recipe.id, FACTS, version=recipe.version)

    assert stale.status_code == 409
    assert response.status_code == 200
    assert response.json()["status"] == "awaiting_review"
