"""The enrich CLI writes a Pending recipe's parse facts, which moves its Enrichment Status."""

from typing import TYPE_CHECKING, Any

import pytest
from conftest import EDITOR

from recipes.auth import SERVICE_TOKEN_HEADER
from recipes.seed import RECIPES

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
