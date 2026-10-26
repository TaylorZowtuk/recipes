"""The enrich CLI writes a Pending recipe's parse facts, which moves its Enrichment Status."""

import hashlib
from typing import TYPE_CHECKING, Any

import pytest
from fastapi.testclient import TestClient

from recipes.api import create_app
from recipes.auth import SERVICE_TOKEN_HEADER, Auth, AuthSettings, Claims, InvalidIdToken
from recipes.seed import RECIPES
from recipes.store import Store

if TYPE_CHECKING:
    from collections.abc import Iterator

    from httpx2 import Response

    from recipes.images import ImageStore
    from recipes.models import Recipe

SERVICE_TOKEN = "synthetic-service-token"
EDITOR = {SERVICE_TOKEN_HEADER: SERVICE_TOKEN}
SETTINGS = AuthSettings.parse(
    {"service-token-hash": hashlib.sha256(SERVICE_TOKEN.encode()).hexdigest()}
)
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


def no_sign_in(token: str, audience: str) -> Claims:
    raise InvalidIdToken(token)


@pytest.fixture
def api_store(table: str) -> Store:
    return Store(table)


@pytest.fixture
def client(api_store: Store, images: ImageStore) -> Iterator[TestClient]:
    auth = Auth(settings=lambda: SETTINGS, verifier=no_sign_in)
    app = create_app(store=lambda: api_store, auth=lambda: auth, images=lambda: images)
    with TestClient(app, follow_redirects=False) as client:
        yield client


def add(store: Store, recipe: Recipe = PENDING, **fields: object) -> Recipe:
    return store.add_recipe(recipe.model_copy(update=fields))


def enrich(
    client: TestClient,
    recipe_id: str,
    facts: dict[str, Any] = FACTS,
    headers: dict[str, str] = EDITOR,
) -> Response:
    body = {"enrichment_version": 1, "facts": facts}
    return client.put(f"/api/recipes/{recipe_id}/enrichment", json=body, headers=headers)


def fetch(client: TestClient, recipe_id: str) -> dict[str, Any]:
    return client.get(f"/api/recipes/{recipe_id}", follow_redirects=True).json()


@pytest.mark.parametrize(
    ("channel", "status"),
    [("add_a_recipe", "awaiting_review"), ("bulk_import", "ready"), (None, "awaiting_review")],
)
def test_enriching_moves_a_pending_recipe_on_by_its_ingest_channel(
    client: TestClient, api_store: Store, channel: str | None, status: str
) -> None:
    recipe = add(api_store, ingest_channel=channel)

    response = enrich(client, recipe.id)

    assert response.status_code == 200
    assert response.json()["status"] == status
    assert response.json()["version"] == recipe.version + 1
    assert fetch(client, recipe.id)["status"] == status


def test_the_facts_and_enrichment_version_are_stored_with_the_recipe(
    client: TestClient, api_store: Store
) -> None:
    recipe = add(api_store, ingest_channel="add_a_recipe")

    enrich(client, recipe.id)

    stored = fetch(client, recipe.id)
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


def test_the_card_shows_the_new_status(client: TestClient, api_store: Store) -> None:
    recipe = add(api_store, ingest_channel="add_a_recipe")

    enrich(client, recipe.id)

    cards = client.get("/api/collection", follow_redirects=True).json()["cards"]
    card = next(card for card in cards if card["id"] == recipe.id)
    assert card["status"] == "awaiting_review"
    assert card["recipe_version"] == recipe.version + 1
    assert card["needs_review"] == {"open_issues": 0, "unconfirmed": 0}


def test_a_recipe_that_is_not_pending_is_refused(client: TestClient, api_store: Store) -> None:
    recipe = add(api_store, READY)

    response = enrich(client, recipe.id)

    assert response.status_code == 409
    assert fetch(client, recipe.id) == recipe.model_dump(mode="json")


def test_a_fact_for_a_line_the_recipe_lacks_is_refused(
    client: TestClient, api_store: Store
) -> None:
    recipe = add(api_store)
    facts = {"ingredients": {"i99": FACTS["ingredients"]["i1"]}}

    response = enrich(client, recipe.id, facts)

    assert response.status_code == 422
    assert fetch(client, recipe.id)["status"] == "pending"


def test_only_an_editor_can_enrich(client: TestClient, api_store: Store) -> None:
    recipe = add(api_store)

    for headers in ({}, {SERVICE_TOKEN_HEADER: "wrong-token"}):
        response = enrich(client, recipe.id, headers=headers)

        assert response.status_code == 403
    assert fetch(client, recipe.id)["status"] == "pending"


def test_an_unknown_recipe_is_not_found(client: TestClient) -> None:
    assert enrich(client, MISSING_ID).status_code == 404
