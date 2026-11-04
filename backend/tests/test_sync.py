from typing import TYPE_CHECKING, Any, Never

import pytest
from conftest import EDITOR
from fastapi.testclient import TestClient

from recipes.seed import RECIPES
from recipes.store import week_key

if TYPE_CHECKING:
    from fastapi import FastAPI

    from recipes.store import Store

MONDAY, NEXT_MONDAY = "2026-11-02", "2026-11-09"


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


def plan(editor_client: TestClient, store: Store, monday: str, writes: int = 1) -> None:
    """A Week Plan at version `writes`."""
    recipe = store.add_recipe(RECIPES[writes])
    for version in range(writes):
        operation = {"op": "place", "day": 0, "recipe_id": recipe.id}
        body = {"version": version, "operations": [operation]}
        response = editor_client.patch(f"/api/weeks/{monday}", json=body, headers=EDITOR)
        assert response.status_code == 200


def watching(*weeks: str) -> dict[str, Any]:
    return {"weeks": list(weeks)}


def test_sync_reports_the_watched_weeks_to_an_editor(
    editor_client: TestClient, store: Store
) -> None:
    plan(editor_client, store, MONDAY, writes=2)
    plan(editor_client, store, "2026-11-16")

    response = editor_client.get("/api/sync", params=watching(MONDAY, NEXT_MONDAY), headers=EDITOR)

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["weeks"] == {MONDAY: 2, NEXT_MONDAY: 0}


def test_sync_reads_the_watched_weeks_in_one_batch(
    editor_client: TestClient, api_store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[dict[str, Any]] = []
    batch_get_item = api_store.client.batch_get_item

    def counted(**request: Any) -> Any:
        calls.append(request)
        return batch_get_item(**request)

    monkeypatch.setattr(api_store.client, "batch_get_item", counted)

    response = editor_client.get(
        "/api/sync", params=watching(MONDAY, NEXT_MONDAY, MONDAY), headers=EDITOR
    )

    assert response.json()["weeks"] == {MONDAY: 0, NEXT_MONDAY: 0}
    (call,) = calls
    keys = call["RequestItems"][api_store.table]["Keys"]
    assert keys == [week_key(MONDAY), week_key(NEXT_MONDAY)]


def test_sync_retries_weeks_dynamodb_left_unprocessed(
    editor_client: TestClient, api_store: Store, store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    plan(editor_client, store, MONDAY, writes=2)
    plan(editor_client, store, NEXT_MONDAY)
    batch_get_item = api_store.client.batch_get_item
    table = api_store.table
    calls: list[list[Any]] = []

    def one_key_at_a_time(**request: Any) -> Any:
        wanted: Any = request["RequestItems"][table]
        first, *rest = wanted["Keys"]
        calls.append(wanted["Keys"])
        one: Any = {table: {**wanted, "Keys": [first]}}
        left: Any = {table: {**wanted, "Keys": rest}} if rest else {}
        return {**batch_get_item(RequestItems=one), "UnprocessedKeys": left}

    def no_wait(_seconds: float) -> None:
        pass

    monkeypatch.setattr(api_store.client, "batch_get_item", one_key_at_a_time)
    monkeypatch.setattr(api_store, "sleep", no_wait)

    response = editor_client.get("/api/sync", params=watching(MONDAY, NEXT_MONDAY), headers=EDITOR)

    assert response.json()["weeks"] == {MONDAY: 2, NEXT_MONDAY: 1}
    assert len(calls) == 2


def test_an_editor_watching_nothing_gets_no_weeks_and_reads_none(
    editor_client: TestClient, api_store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(api_store.client, "batch_get_item", refuse_to_read)

    response = editor_client.get("/api/sync", headers=EDITOR)

    assert response.status_code == 200
    assert response.json()["weeks"] == {}


def refuse_to_read(**_request: object) -> Never:
    msg = "Sync read a Week Plan"
    raise AssertionError(msg)


@pytest.mark.parametrize(
    "weeks",
    [
        [MONDAY],
        ["2026-11-03"],  # asking about a bad date tells a visitor nothing either
        ["nonsense"],
        [MONDAY] * 9,
    ],
)
def test_a_visitor_gets_no_weeks_and_no_week_is_read(
    editor_client: TestClient,
    store: Store,
    api_store: Store,
    monkeypatch: pytest.MonkeyPatch,
    weeks: list[str],
) -> None:
    plan(editor_client, store, MONDAY)
    monkeypatch.setattr(api_store.client, "batch_get_item", refuse_to_read)

    response = editor_client.get("/api/sync", params={"weeks": weeks})

    assert response.status_code == 200
    assert response.json()["weeks"] is None


@pytest.mark.parametrize(
    "weeks",
    [
        ["2026-11-03"],
        [MONDAY, "2026-11-08"],
        ["20261102"],
        ["2026-W45-1"],
        ["2026-02-30"],
        ["nonsense"],
        [""],
    ],
)
def test_an_editor_watching_a_non_monday_is_refused(
    editor_client: TestClient, weeks: list[str]
) -> None:
    response = editor_client.get("/api/sync", params={"weeks": weeks}, headers=EDITOR)

    assert response.status_code == 422
    assert response.headers["cache-control"] == "no-store"


def test_an_editor_can_watch_up_to_8_weeks(editor_client: TestClient) -> None:
    eight = [f"2026-11-{day:02}" for day in (2, 9, 16, 23, 30)]
    eight += ["2026-12-07", "2026-12-14", "2026-12-21"]

    allowed = editor_client.get("/api/sync", params={"weeks": eight}, headers=EDITOR)
    refused = editor_client.get(
        "/api/sync", params={"weeks": [*eight, "2026-12-28"]}, headers=EDITOR
    )

    assert allowed.status_code == 200
    assert allowed.json()["weeks"] == dict.fromkeys(eight, 0)
    assert refused.status_code == 422


def test_sync_stays_a_get(client: TestClient) -> None:
    assert client.post("/api/sync").status_code == 405
