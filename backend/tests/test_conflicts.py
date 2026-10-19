from typing import TYPE_CHECKING

from fastapi.testclient import TestClient

from recipes.seed import RECIPES

if TYPE_CHECKING:
    from fastapi import FastAPI

    from recipes.store import Store


def test_a_stale_write_returns_409(app: FastAPI, store: Store) -> None:
    added = store.add_recipe(RECIPES[0])
    store.update_recipe(added)

    def stale_write() -> None:
        store.update_recipe(added)

    app.add_api_route("/test/stale-write", stale_write, methods=["POST"])
    with TestClient(app) as client:
        response = client.post("/test/stale-write")

    assert response.status_code == 409
    assert response.json() == {"detail": "Version conflict: reload and try again"}
