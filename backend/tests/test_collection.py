from typing import TYPE_CHECKING

from recipes.seed import RECIPES

if TYPE_CHECKING:
    from fastapi.testclient import TestClient

    from recipes.store import Store

IMMUTABLE = "public, max-age=31536000, immutable"


def test_the_current_version_serves_the_cards_and_kitchen_settings(
    client: TestClient, store: Store
) -> None:
    for recipe in RECIPES[:2]:
        store.add_recipe(recipe)
    version = store.collection_version()

    response = client.get(f"/api/v/collection/{version}")

    assert response.status_code == 200
    assert response.headers["cache-control"] == IMMUTABLE
    body = response.json()
    assert body["collection_version"] == version
    assert [card["id"] for card in body["cards"]] == [recipe.id for recipe in RECIPES[:2]]
    assert body["kitchen_settings"]["store_categories"][0] == {
        "id": "household",
        "name": "Household",
    }


def test_a_stale_version_redirects_to_the_current_one(client: TestClient, store: Store) -> None:
    stale = store.collection_version()
    store.add_recipe(RECIPES[0])

    response = client.get(f"/api/v/collection/{stale}")

    assert response.status_code == 307
    assert response.headers["location"] == f"/api/v/collection/{stale + 1}"
    assert response.headers["cache-control"] == "no-store"


def test_the_unversioned_collection_redirects_to_the_current_version(
    client: TestClient, store: Store
) -> None:
    response = client.get("/api/collection")

    assert response.status_code == 307
    assert response.headers["location"] == f"/api/v/collection/{store.collection_version()}"
    assert response.headers["cache-control"] == "no-store"


def test_a_non_integer_version_is_refused(client: TestClient) -> None:
    response = client.get("/api/v/collection/latest")

    assert response.status_code == 422
    assert response.headers["cache-control"] == "no-store"


def test_another_spelling_of_the_current_version_is_refused(
    client: TestClient, store: Store
) -> None:
    version = store.collection_version()

    for spelling in (f"0{version}", f"+{version}", f"{version}.0"):
        response = client.get(f"/api/v/collection/{spelling}")

        assert response.status_code == 422, spelling
        assert response.headers["cache-control"] == "no-store"
