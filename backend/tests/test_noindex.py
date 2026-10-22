"""Every API response asks not to be indexed, and answers what `make smoke` checks."""

from typing import TYPE_CHECKING

import pytest
from fastapi.testclient import TestClient

if TYPE_CHECKING:
    from collections.abc import Iterator

    from fastapi import FastAPI


@pytest.fixture
def failing_route(app: FastAPI) -> Iterator[str]:
    path = "/api/test-failure"

    def fail() -> None:
        msg = "synthetic failure"
        raise RuntimeError(msg)

    app.add_api_route(path, fail)
    yield path
    app.router.routes.pop()


@pytest.mark.parametrize(
    ("method", "path", "status"),
    [
        ("GET", "/api/sync", 200),
        ("GET", "/api/does-not-exist", 404),
        ("POST", "/api/sync", 405),
        ("GET", "/api/collection", 307),
        ("GET", "/api/recipes/01K7ZZZZZZZZZZZZZZZZZZZZZZ", 404),
        ("GET", "/api/recipes/not-a-ulid", 422),
    ],
)
def test_every_api_response_asks_not_to_be_indexed(
    client: TestClient, method: str, path: str, status: int
) -> None:
    response = client.request(method, path)

    assert response.status_code == status
    assert response.headers["x-robots-tag"] == "noindex"


@pytest.mark.parametrize(
    ("method", "path", "status", "body"),
    [
        ("GET", "/api/does-not-exist", 404, '"detail"'),
        ("GET", "/api/sync", 200, '"collection_version"'),
        ("POST", "/api/sync", 405, '"Method Not Allowed"'),
    ],
)
def test_the_api_answers_what_the_smoke_test_checks(
    client: TestClient, method: str, path: str, status: int, body: str
) -> None:
    response = client.request(method, path)

    assert response.status_code == status
    assert response.headers["content-type"].startswith("application/json")
    assert body in response.text


def test_an_unhandled_error_asks_not_to_be_indexed_or_cached(
    app: FastAPI, failing_route: str
) -> None:
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get(failing_route)

    assert response.status_code == 500
    assert response.json() == {"detail": "Internal Server Error"}
    assert response.headers["x-robots-tag"] == "noindex"
    assert response.headers["cache-control"] == "no-store"
