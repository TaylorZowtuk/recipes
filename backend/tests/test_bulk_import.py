"""The bulk import CLI ingests each website Source in a sources file through the API as the bulk
import. A Source a plain fetch can't read is left queued for the fallback, and one already in the
Collection is skipped, so a re-run is safe.
"""

import io
import sys
from typing import TYPE_CHECKING, Any

import pytest
import requests
from conftest import EDITOR, SERVICE_TOKEN
from fake_web import FakeWeb, Served, page, photo
from test_enrich import BASE_URL, api, through

from recipes import bulk_import
from recipes.bulk_import import main, run
from recipes.client import SERVICE_TOKEN_ENV, SameOriginSession

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from fastapi.testclient import TestClient

    from recipes.client import Send
    from recipes.ingest import Fetcher

SITE = "https://plateful.test"
PHOTO = f"{SITE}/photos/miso-soup.jpg"
WIDE_PHOTO = f"{SITE}/photos/miso-soup-wide.jpg"
# main's base URL must be a local dev host's, and the in-process API answers any host.
LOCAL_URL = "http://localhost"
RECIPE = f"{SITE}/miso-soup"
BLOCKED = f"{SITE}/blocked-stew"
MISSING = f"{SITE}/missing-pie"
REFUSED = requests.ConnectionError("connection refused")
# A synthetic sources file: one Source of each outcome, and a Source that isn't a website.
SOURCES = f"""kind,location,notes
website,{RECIPE},a weeknight soup
website,{BLOCKED},
spreadsheet,Family recipes sheet,"the tab with the cakes, mostly"
website,{MISSING},
"""


@pytest.fixture
def web() -> FakeWeb:
    """The web the API fetches from: a recipe with its two photos, a site that blocks Plateful, and
    404 for the missing page.
    """
    return FakeWeb(
        {
            RECIPE: (200, page("json-ld-recipe.html")),
            PHOTO: Served(200, photo(), content_type="image/png"),
            WIDE_PHOTO: Served(200, photo(colour="teal"), content_type="image/png"),
            BLOCKED: (403, "Forbidden"),
        }
    )


@pytest.fixture
def fetcher(web: FakeWeb) -> Callable[[], Fetcher]:
    return web.fetcher


@pytest.fixture
def send(editor_client: TestClient) -> Send:
    return through(api(editor_client))


def recipes(client: TestClient) -> list[dict[str, Any]]:
    cards = client.get("/api/collection", follow_redirects=True).json()["cards"]
    return [
        client.get(f"/api/recipes/{card['id']}", follow_redirects=True).json() for card in cards
    ]


def queued_urls(client: TestClient) -> list[str]:
    listed = client.get("/api/queued-ingests", headers=EDITOR).json()
    return [queued["source"]["url"] for queued in listed]


def test_a_website_source_is_saved_as_the_bulk_import_with_its_photos(
    editor_client: TestClient, send: Send
) -> None:
    failed = run(BASE_URL, send, io.StringIO(f"kind,location,notes\nwebsite,{RECIPE},\n"))

    assert failed == 0
    [recipe] = recipes(editor_client)
    assert recipe["ingest_channel"] == "bulk_import"
    assert recipe["status"] == "pending"
    assert recipe["source"]["url"] == RECIPE
    assert recipe["original"]["extractor"] == "recipe-scrapers"
    assert [image["origin"] for image in recipe["images"]] == [PHOTO, WIDE_PHOTO]
    assert recipe["preview"] == {
        "image_id": recipe["images"][0]["id"],
        "focal_x": 0.5,
        "focal_y": 0.5,
    }


def test_each_source_is_ingested_queued_skipped_or_failed_and_summarised(
    editor_client: TestClient, send: Send, capsys: pytest.CaptureFixture[str]
) -> None:
    failed = run(BASE_URL, send, io.StringIO(SOURCES))

    assert failed == 1
    assert [recipe["source"]["url"] for recipe in recipes(editor_client)] == [RECIPE]
    assert queued_urls(editor_client) == [BLOCKED]
    printed = capsys.readouterr()
    assert printed.err.splitlines() == [
        f"{RECIPE} → ingested",
        f"{BLOCKED} → queued for the fallback (blocked)",
        "Family recipes sheet → skipped (not a website Source)",
        f"{MISSING} → failed: 404 That page isn't on the website",
    ]
    assert printed.out.splitlines() == [
        "Ingested 1, skipped 1, queued 1, failed 1",
        "Failed:",
        f"  {MISSING}: 404 That page isn't on the website",
        (
            "Run the fallback to finish the queued Sources: "
            f"make fallback ARGS='run {BASE_URL}', or the enrich-pending skill"
        ),
    ]


def test_a_rerun_skips_every_source_already_ingested_or_queued(
    editor_client: TestClient, send: Send, capsys: pytest.CaptureFixture[str]
) -> None:
    run(BASE_URL, send, io.StringIO(SOURCES))
    capsys.readouterr()

    failed = run(BASE_URL, send, io.StringIO(SOURCES))

    assert failed == 1
    assert len(recipes(editor_client)) == 1
    assert queued_urls(editor_client) == [BLOCKED]
    printed = capsys.readouterr()
    assert f"{RECIPE} → skipped (Already in the Collection)" in printed.err
    assert f"{BLOCKED} → skipped (Already waiting to be ingested)" in printed.err
    assert printed.out.splitlines()[0] == "Ingested 0, skipped 3, queued 0, failed 1"
    assert "fallback" not in printed.out


def test_a_failure_on_one_source_never_stops_the_others(
    editor_client: TestClient, send: Send, capsys: pytest.CaptureFixture[str]
) -> None:
    def unreachable_for_the_blocked_site(method: str, url: str, body: bytes | None) -> Any:
        if body and BLOCKED.encode() in body:
            raise REFUSED
        return send(method, url, body)

    failed = run(BASE_URL, unreachable_for_the_blocked_site, io.StringIO(SOURCES))

    assert failed == 2
    assert [recipe["source"]["url"] for recipe in recipes(editor_client)] == [RECIPE]
    assert f"  {BLOCKED}: connection refused" in capsys.readouterr().out


def test_a_recipe_the_api_refuses_to_save_fails_that_source(
    editor_client: TestClient, send: Send, capsys: pytest.CaptureFixture[str]
) -> None:
    def refusing_saves(method: str, url: str, body: bytes | None) -> Any:
        if url == f"{BASE_URL}/api/recipes":
            return 500, {"detail": "Internal Server Error"}
        return send(method, url, body)

    failed = run(BASE_URL, refusing_saves, io.StringIO(f"kind,location,notes\nwebsite,{RECIPE},\n"))

    assert failed == 1
    assert recipes(editor_client) == []
    assert f"  {RECIPE}: 500 Internal Server Error" in capsys.readouterr().out


def through_the_api(monkeypatch: pytest.MonkeyPatch, client: TestClient) -> None:
    """Points `main`'s session at the in-process API, signed in with the service token."""

    def session() -> SameOriginSession:
        session = SameOriginSession()
        session.mount("http://", api(client))
        return session

    monkeypatch.setattr(bulk_import, "SameOriginSession", session)
    monkeypatch.setenv(SERVICE_TOKEN_ENV, SERVICE_TOKEN)


def test_main_reads_the_sources_from_stdin_and_exits_1_when_any_failed(
    editor_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    through_the_api(monkeypatch, editor_client)
    monkeypatch.setattr(sys, "stdin", io.StringIO(SOURCES))

    with pytest.raises(SystemExit) as exited:
        main([LOCAL_URL, "-"])

    assert exited.value.code == 1
    assert len(recipes(editor_client)) == 1


def test_main_reads_a_sources_file_and_exits_0_when_none_failed(
    editor_client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    through_the_api(monkeypatch, editor_client)
    sources = tmp_path / "sources.csv"
    sources.write_text(f"kind,location,notes\nwebsite,{RECIPE},\nwebsite,{BLOCKED},\n")

    with pytest.raises(SystemExit) as exited:
        main([LOCAL_URL, str(sources)])

    assert exited.value.code == 0
    assert queued_urls(editor_client) == [BLOCKED]


def test_main_needs_the_service_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(SERVICE_TOKEN_ENV, raising=False)

    with pytest.raises(SystemExit, match=SERVICE_TOKEN_ENV):
        main([LOCAL_URL, "-"])
