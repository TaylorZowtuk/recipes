from typing import TYPE_CHECKING

from recipes.models import SCHEMA_VERSION
from recipes.seed import RECIPES

if TYPE_CHECKING:
    from fastapi.testclient import TestClient

    from recipes.store import Store

IMMUTABLE = "public, max-age=31536000, immutable"
MISSING_ID = "01K7ZZZZZZZZZZZZZZZZZZZZZZ"


def test_the_current_version_serves_the_recipe(client: TestClient, store: Store) -> None:
    recipe = store.add_recipe(RECIPES[1])

    response = client.get(f"/api/v/recipes/{recipe.id}/{recipe.version}/{SCHEMA_VERSION}")

    assert response.status_code == 200
    assert response.headers["cache-control"] == IMMUTABLE
    assert response.json() == recipe.model_dump(mode="json")
    first_line = response.json()["original"]["ingredients"][0]["text"]
    assert first_line == recipe.original.ingredients[0].text


def test_a_stale_recipe_or_schema_version_redirects_to_the_current_one(
    client: TestClient, store: Store
) -> None:
    first = store.add_recipe(RECIPES[1])
    current = store.update_recipe(first.model_copy(update={"tags": ["weeknight"]}))
    location = f"/api/v/recipes/{current.id}/{current.version}/{SCHEMA_VERSION}"

    for versions in (
        f"{first.version}/{SCHEMA_VERSION}",
        f"{current.version}/{SCHEMA_VERSION - 1}",
    ):
        response = client.get(f"/api/v/recipes/{current.id}/{versions}")

        assert response.status_code == 307, versions
        assert response.headers["location"] == location
        assert response.headers["cache-control"] == "no-store"


def test_the_unversioned_recipe_redirects_to_its_current_version(
    client: TestClient, store: Store
) -> None:
    recipe = store.add_recipe(RECIPES[1])

    response = client.get(f"/api/recipes/{recipe.id}")

    assert response.status_code == 307
    assert response.headers["location"] == (
        f"/api/v/recipes/{recipe.id}/{recipe.version}/{SCHEMA_VERSION}"
    )
    assert response.headers["cache-control"] == "no-store"


def test_an_unknown_recipe_is_not_found(client: TestClient) -> None:
    for path in (f"/api/v/recipes/{MISSING_ID}/1/{SCHEMA_VERSION}", f"/api/recipes/{MISSING_ID}"):
        response = client.get(path)

        assert response.status_code == 404, path
        assert response.headers["cache-control"] == "no-store"


def test_a_malformed_recipe_id_or_version_is_refused(client: TestClient) -> None:
    for path in (
        f"/api/v/recipes/not-a-ulid/1/{SCHEMA_VERSION}",
        f"/api/v/recipes/{MISSING_ID}/one/{SCHEMA_VERSION}",
        "/api/recipes/not-a-ulid",
    ):
        response = client.get(path)

        assert response.status_code == 422, path
        assert response.headers["cache-control"] == "no-store"
