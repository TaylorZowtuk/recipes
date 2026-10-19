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

    response = client.get(f"/api/recipes/{recipe.id}?v={recipe.version}&s={SCHEMA_VERSION}")

    assert response.status_code == 200
    assert response.headers["cache-control"] == IMMUTABLE
    assert response.json() == recipe.model_dump(mode="json")
    first_line = response.json()["original"]["ingredients"][0]["text"]
    assert first_line == recipe.original.ingredients[0].text


def test_a_stale_or_missing_version_redirects_to_the_current_one(
    client: TestClient, store: Store
) -> None:
    first = store.add_recipe(RECIPES[1])
    current = store.update_recipe(first.model_copy(update={"tags": ["weeknight"]}))
    location = f"/api/recipes/{current.id}?v={current.version}&s={SCHEMA_VERSION}"

    for query in (
        f"?v={first.version}&s={SCHEMA_VERSION}",
        f"?v={current.version}&s={SCHEMA_VERSION - 1}",
        "",
    ):
        response = client.get(f"/api/recipes/{current.id}{query}")

        assert response.status_code == 307, query
        assert response.headers["location"] == location
        assert response.headers["cache-control"] == "no-store"


def test_an_unknown_recipe_is_not_found(client: TestClient) -> None:
    response = client.get(f"/api/recipes/{MISSING_ID}?v=1&s={SCHEMA_VERSION}")

    assert response.status_code == 404
    assert response.headers["cache-control"] == "no-store"


def test_a_malformed_recipe_id_is_refused(client: TestClient) -> None:
    response = client.get("/api/recipes/not-a-ulid")

    assert response.status_code == 422
