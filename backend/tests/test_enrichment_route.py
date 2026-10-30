"""The enrich CLI writes a Pending recipe's parse facts, which moves its Enrichment Status."""

import json
from typing import TYPE_CHECKING, Any

import pytest
from conftest import EDITOR

from recipes.auth import SERVICE_TOKEN_HEADER
from recipes.models import (
    MAX_LABEL,
    MAX_RECIPE_BYTES,
    CanonicalIngredient,
    EnrichmentIssue,
    Wording,
)
from recipes.seed import RECIPES
from recipes.store import MAX_LEARNED

if TYPE_CHECKING:
    from fastapi.testclient import TestClient
    from httpx2 import Response

    from recipes.models import Recipe
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
    body = {"enrichment_version": 1, "facts": facts}
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
    assert card["needs_review"] == {"open_issues": 0, "unconfirmed": 0}


def test_a_recipe_that_is_not_pending_is_refused(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = add(api_store, READY)

    response = enrich(editor_client, recipe.id)

    assert response.status_code == 409
    assert fetch(editor_client, recipe.id) == recipe.model_dump(mode="json")


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
FDC = {"provenance": "fdc", "confidence": 0.8, "estimated": True}
MATCHED = {
    "ingredients": {
        "i1": {
            **FACTS["ingredients"]["i1"],
            "match": {**LLM, "canonical_id": BEEF_ID, "fdc_id": 1001, "portion_id": None},
            "conversion": {
                **FDC,
                "fdc_id": 1001,
                "dataset": "sr_legacy",
                "release": "foundation-2026-04-01+sr_legacy-2018-04",
                "density_g_per_ml": None,
                "grams_per_count": None,
                "count_unit": None,
                "refused": "The line is already a weight",
                "per_100g": {
                    "kcal": 150.0,
                    "protein_g": 20.0,
                    "fat_g": 7.0,
                    "carbs_g": 0.0,
                    "sodium_mg": None,
                },
            },
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
        "fdc_release": "foundation-2026-04-01+sr_legacy-2018-04",
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
    assert stored["fdc_release"] == "foundation-2026-04-01+sr_legacy-2018-04"
    assert stored["issues"] == [issue(1)]
    beef = stored["facts"]["ingredients"]["i1"]
    assert beef["match"]["canonical_id"] == BEEF_ID
    assert beef["conversion"]["per_100g"]["kcal"] == 150
    assert beef["conversion"]["refused"] == "The line is already a weight"
    collection = bundle(editor_client)
    assert collection["collection_version"] == before + 1
    assert collection["canonical_ingredients"] == [
        {**BEEF, "pantry_staple": False, "confirmed": False}
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


def test_the_card_counts_the_open_issues(editor_client: TestClient, api_store: Store) -> None:
    issues = [
        EnrichmentIssue.model_validate(issue(n, status))
        for n, status in enumerate(["open", "resolved", "open"], 1)
    ]
    recipe = api_store.enrich_recipe(add(api_store).model_copy(update={"issues": issues}), [], [])

    card = next(card for card in bundle(editor_client)["cards"] if card["id"] == recipe.id)
    assert card["needs_review"] == {"open_issues": 2, "unconfirmed": 0}


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
    "fact_id", ["i10.match", "i1.segments", "i1"], ids=["no such line", "no such fact", "no fact"]
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
