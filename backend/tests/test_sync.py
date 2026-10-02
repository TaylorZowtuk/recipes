from fastapi.testclient import TestClient

from recipes.api import app


def test_sync_reports_the_collection_and_schema_versions() -> None:
    client = TestClient(app)

    response = client.get("/api/sync")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "collection_version": 0,
        "schema_version": 1,
        "read_only": None,
        "weeks": None,
    }
