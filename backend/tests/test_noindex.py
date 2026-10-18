import pytest
from fastapi.testclient import TestClient

from recipes.api import app


@pytest.mark.parametrize(
    ("path", "status"),
    [("/api/sync", 200), ("/api/does-not-exist", 404)],
)
def test_every_api_response_asks_not_to_be_indexed(path: str, status: int) -> None:
    client = TestClient(app)

    response = client.get(path)

    assert response.status_code == status
    assert response.headers["x-robots-tag"] == "noindex"
