from typing import TYPE_CHECKING

import pytest
from fastapi.testclient import TestClient

from recipes.api import app

if TYPE_CHECKING:
    from collections.abc import Iterator


@pytest.fixture
def failing_route() -> Iterator[str]:
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
    ],
)
def test_every_api_response_asks_not_to_be_indexed(method: str, path: str, status: int) -> None:
    client = TestClient(app)

    response = client.request(method, path)

    assert response.status_code == status
    assert response.headers["x-robots-tag"] == "noindex"


def test_an_unhandled_error_asks_not_to_be_indexed(failing_route: str) -> None:
    client = TestClient(app, raise_server_exceptions=False)

    response = client.get(failing_route)

    assert response.status_code == 500
    assert response.json() == {"detail": "Internal Server Error"}
    assert response.headers["x-robots-tag"] == "noindex"
