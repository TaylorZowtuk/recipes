from typing import TYPE_CHECKING

from recipes.seed import RECIPES

if TYPE_CHECKING:
    from fastapi.testclient import TestClient

    from recipes.store import Store


def test_sync_reports_the_collection_and_schema_versions(client: TestClient, store: Store) -> None:
    store.add_recipe(RECIPES[0])

    response = client.get("/api/sync")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "collection_version": store.collection_version(),
        "schema_version": 1,
        "read_only": None,
        "weeks": None,
    }
