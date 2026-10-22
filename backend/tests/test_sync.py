from typing import TYPE_CHECKING

from fastapi.testclient import TestClient

from recipes.seed import RECIPES

if TYPE_CHECKING:
    import pytest
    from fastapi import FastAPI

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


def test_a_failed_sync_is_never_cached(app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> None:
    def unreachable() -> int:
        msg = "DynamoDB is unreachable"
        raise ConnectionError(msg)

    with TestClient(app, raise_server_exceptions=False) as client:
        monkeypatch.setattr(app.state.store, "collection_version", unreachable)
        response = client.get("/api/sync")

    assert response.status_code == 500
    assert response.headers["cache-control"] == "no-store"
