"""The fallback CLI takes each waiting Queued Ingest through the browser, then recipe-scrapers,
then a model's answer, through the API. A fake page fetcher stands in for the browser here:
tests/test_browser.py runs the real one.
"""

import io
import json
import re
import socket
from contextlib import nullcontext
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import pytest
import requests
from conftest import SERVICE_TOKEN
from fake_web import FakeWeb, Served, page, photo
from test_enrich import (
    BASE_URL,
    SNAPSHOT,
    api,
    stored,
    through,
    work_packet,
)

from recipes import enrich, fallback
from recipes.fallback import (
    Extracted,
    NeedsLlm,
    NeedsPage,
    StillWaiting,
    apply,
    capture,
    main,
    run,
    verbatim_errors,
)
from recipes.ingest import (
    BROWSER_EXTRACTOR,
    LLM_EXTRACTOR,
    FetchRefused,
    IngestFailed,
    PageNotFound,
    PoliteFetcher,
    RenderedPage,
    raise_for_page_status,
    website_dedupe_key,
)
from recipes.models import SCHEMA_VERSION, Original, QueuedIngest, SpreadsheetSource, new_ulid

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping

    from fastapi.testclient import TestClient
    from requests.models import PreparedRequest

    from recipes.client import Send
    from recipes.ingest import Fetcher
    from recipes.models import QueuedIngestReason
    from recipes.store import Store

SITE = "https://plateful.test"
PHOTO = f"{SITE}/photos/miso-soup.jpg"
WIDE_PHOTO = f"{SITE}/photos/miso-soup-wide.jpg"
# What a model sees of a page with no schema.org recipe.
TEXT = """Plum Chutney   by a test cook
2 plums, chopped
1 cup   sugar
Simmer the plums
with the sugar. Serve cold.
A line of the page's own chatter."""
# TEXT with everything else an Original can quote.
FULL_TEXT = f"""{TEXT}
Makes 2 jars
Prep: 10 minutes
Cook: 1 hour
Total: 70 minutes"""
NO_RECIPE = page("no-recipe.html")
RECIPE = page("json-ld-recipe.html")


def queue(store: Store, slug: str, state: str = "waiting", site: str = SITE) -> QueuedIngest:
    url = f"{site}/{slug}"
    queued = QueuedIngest.model_validate(
        {
            "schema_version": SCHEMA_VERSION,
            "id": new_ulid(),
            "source": {
                "kind": "website",
                "url": url,
                "site_name": "plateful.test",
                "captured_at": "2026-10-01T12:00:00Z",
            },
            "dedupe_key": website_dedupe_key(url),
            "state": state,
            "reason": "no_recipe",
            "queued_at": "2026-10-01T12:00:00Z",
        }
    )
    store.queue_ingest(queued)
    return queued


def fake_browser(
    pages: Mapping[str, RenderedPage | Exception | int],
) -> Callable[[str], RenderedPage]:
    """Answers each URL from `pages`, raising what's an exception, and failing a status code as
    the real browser does.
    """

    def fetch(url: str) -> RenderedPage:
        served = pages[url]
        if isinstance(served, Exception):
            raise served
        if isinstance(served, int):
            raise_for_page_status(served, url)
            pytest.fail(f"{served} isn't a status the browser fails on")
        return served

    return fetch


def rendered(html: str = NO_RECIPE, text: str = TEXT, url: str = f"{SITE}/final") -> RenderedPage:
    return RenderedPage(html=html, url=url, text=text)


def original(**fields: Any) -> dict[str, Any]:
    """A model's answer for TEXT."""
    return {
        "title": "Plum Chutney",
        "ingredients": [
            {"id": "i1", "text": "2 plums, chopped"},
            {"id": "i2", "text": "1 cup sugar"},
        ],
        "steps": [{"id": "s1", "text": "Simmer the plums with the sugar."}],
        **fields,
    }


def an_original(quote: str) -> Original:
    """An Original whose every quote is `quote`."""
    line = {"id": "l1", "text": quote}
    return Original.model_validate(
        {"title": quote, "extractor": "llm", "ingredients": [line], "steps": [line]}
    )


def packet_of(*queued: QueuedIngest, text: str = TEXT) -> str:
    return json.dumps(
        {
            "instructions": "Any",
            "items": [{"id": q.id, "url": q.source.url, "text": text} for q in queued],  # pyright: ignore[reportAttributeAccessIssue]
        }
    )


def answer_of(*answers: tuple[QueuedIngest, dict[str, Any] | None]) -> str:
    return json.dumps({"answers": [{"id": q.id, "original": o} for q, o in answers]})


def queue_state(client: TestClient) -> dict[str, tuple[str, str]]:
    listed = client.get("/api/queued-ingests", headers=EDITOR).json()
    return {q["id"]: (q["state"], q["reason"]) for q in listed}


def only_recipe(client: TestClient) -> dict[str, Any]:
    cards = client.get("/api/collection", follow_redirects=True).json()["cards"]
    assert len(cards) == 1
    return stored(client, cards[0]["id"])


EDITOR = {"x-plateful-service-token": SERVICE_TOKEN}


@pytest.fixture
def web() -> FakeWeb:
    """The web the API stores candidate photos from."""
    return FakeWeb({PHOTO: Served(200, photo(), content_type="image/png")})


@pytest.fixture
def fetcher(web: FakeWeb) -> Callable[[], Fetcher]:
    return web.fetcher


@pytest.fixture
def send(editor_client: TestClient) -> Send:
    return through(api(editor_client))


# The chain


def test_a_page_with_a_recipe_is_captured_from_the_browsers_final_url() -> None:
    final = "https://moved.test/recipes/soup"
    pages: dict[str, RenderedPage | Exception] = {f"{SITE}/start": rendered(RECIPE, url=final)}

    outcome = capture(f"{SITE}/start", fake_browser(pages))

    assert isinstance(outcome, Extracted)
    assert outcome.captured.original.title == "Weeknight Miso Soup"
    assert outcome.captured.original.extractor == BROWSER_EXTRACTOR
    assert outcome.captured.candidate_photos == [
        PHOTO,
        "https://moved.test/photos/miso-soup-wide.jpg",
    ]


def test_a_page_without_a_recipe_needs_the_llm_with_its_visible_text() -> None:
    outcome = capture(f"{SITE}/start", fake_browser({f"{SITE}/start": rendered()}))

    assert outcome == NeedsLlm(text=TEXT)


def test_a_page_with_no_text_at_all_needs_its_page() -> None:
    outcome = capture(f"{SITE}/start", fake_browser({f"{SITE}/start": rendered(text=" \n ")}))

    assert outcome == NeedsPage(reason="no_recipe")


@pytest.mark.parametrize(
    ("failure", "reason"),
    [
        (FetchRefused(reason="robots"), "robots"),
        (FetchRefused(reason="blocked"), "blocked"),
        (IngestFailed(reason="blocked"), "blocked"),
        (PageNotFound("gone"), "unreachable"),
    ],
)
def test_a_page_the_browser_cannot_load_needs_its_page(failure: Exception, reason: str) -> None:
    outcome = capture(f"{SITE}/start", fake_browser({f"{SITE}/start": failure}))

    assert outcome == NeedsPage(reason=reason)  # pyright: ignore[reportArgumentType]


@pytest.mark.parametrize("reason", ["rate_limited", "server_error", "unreachable"])
def test_a_temporary_failure_stays_waiting(reason: QueuedIngestReason) -> None:
    failure = IngestFailed(reason=reason)

    outcome = capture(f"{SITE}/start", fake_browser({f"{SITE}/start": failure}))

    assert outcome == StillWaiting(reason=reason)


def test_the_browser_comes_first_and_scrapers_before_the_llm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    steps: list[str] = []
    real_parse = fallback.parse

    def fetch(_url: str) -> RenderedPage:
        steps.append("browser")
        return rendered()

    def parse(html: str, url: str) -> Any:
        steps.append("recipe-scrapers")
        return real_parse(html, url)

    monkeypatch.setattr(fallback, "parse", parse)

    assert isinstance(capture(f"{SITE}/start", fetch), NeedsLlm)
    assert steps == ["browser", "recipe-scrapers"]


# run


def test_run_saves_what_the_browser_captured_with_its_photos(
    editor_client: TestClient, api_store: Store, send: Send, capsys: pytest.CaptureFixture[str]
) -> None:
    queued = queue(api_store, "soup")

    failed = run(BASE_URL, send, fake_browser({queued.source.url: rendered(RECIPE)}))  # pyright: ignore[reportAttributeAccessIssue]

    assert failed == 0
    recipe = only_recipe(editor_client)
    assert recipe["original"]["extractor"] == BROWSER_EXTRACTOR
    assert recipe["status"] == "pending"
    assert recipe["source"]["url"] == f"{SITE}/soup"
    assert recipe["source"]["site_name"] == "Plateful Test Kitchen"
    assert [image["origin"] for image in recipe["images"]] == [PHOTO]
    assert recipe["preview"] == {
        "image_id": recipe["images"][0]["id"],
        "focal_x": 0.5,
        "focal_y": 0.5,
    }
    assert queue_state(editor_client) == {}
    printed = capsys.readouterr()
    assert json.loads(printed.out)["items"] == []
    assert "Saved 1, 0 for the LLM, 0 need their page, 0 failed" in printed.err


def test_two_candidates_that_are_one_photo_are_stored_once(
    editor_client: TestClient,
    api_store: Store,
    send: Send,
    web: FakeWeb,
) -> None:
    web.pages[WIDE_PHOTO] = web.pages[PHOTO]
    queued = queue(api_store, "soup")

    assert run(BASE_URL, send, fake_browser({queued.source.url: rendered(RECIPE)})) == 0  # pyright: ignore[reportAttributeAccessIssue]

    assert len(only_recipe(editor_client)["images"]) == 1


def test_a_recipe_whose_photos_all_fail_is_saved_without_a_preview(
    editor_client: TestClient, api_store: Store, send: Send, web: FakeWeb
) -> None:
    del web.pages[PHOTO]
    queued = queue(api_store, "soup")

    assert run(BASE_URL, send, fake_browser({queued.source.url: rendered(RECIPE)})) == 0  # pyright: ignore[reportAttributeAccessIssue]

    recipe = only_recipe(editor_client)
    assert recipe["images"] == []
    assert recipe["preview"] is None


@pytest.mark.parametrize(
    "failure",
    [(500, "Server trouble"), (200, {"not": "an image"}), requests.ConnectionError("Network down")],
)
def test_a_photo_that_fails_to_store_is_dropped_and_the_recipe_still_saved(
    editor_client: TestClient,
    api_store: Store,
    send: Send,
    capsys: pytest.CaptureFixture[str],
    failure: tuple[int, Any] | Exception,
) -> None:
    def no_photos(method: str, url: str, body: bytes | None) -> tuple[int, Any]:
        if not url.endswith("/api/images"):
            return send(method, url, body)
        if isinstance(failure, Exception):
            raise failure
        return failure

    queued = queue(api_store, "soup")

    assert run(BASE_URL, no_photos, fake_browser({queued.source.url: rendered(RECIPE)})) == 0  # pyright: ignore[reportAttributeAccessIssue]

    assert only_recipe(editor_client)["images"] == []
    assert f"Dropped the photo {PHOTO!r}:" in capsys.readouterr().err


def test_the_first_of_two_stored_photos_is_the_preview(
    editor_client: TestClient, api_store: Store, send: Send, web: FakeWeb
) -> None:
    web.pages[WIDE_PHOTO] = Served(200, photo(colour="teal"), content_type="image/png")
    queued = queue(api_store, "soup")

    assert run(BASE_URL, send, fake_browser({queued.source.url: rendered(RECIPE)})) == 0  # pyright: ignore[reportAttributeAccessIssue]

    recipe = only_recipe(editor_client)
    assert [image["origin"] for image in recipe["images"]] == [PHOTO, WIDE_PHOTO]
    assert recipe["preview"]["image_id"] == recipe["images"][0]["id"]


def test_a_saved_source_is_captured_when_it_was_saved_not_when_it_was_queued(
    editor_client: TestClient, api_store: Store, send: Send
) -> None:
    queued = queue(api_store, "soup")
    started = datetime.now(UTC)

    assert run(BASE_URL, send, fake_browser({queued.source.url: rendered(RECIPE)})) == 0  # pyright: ignore[reportAttributeAccessIssue]

    assert datetime.fromisoformat(only_recipe(editor_client)["source"]["captured_at"]) >= started


def test_run_prints_a_work_packet_of_the_pages_that_need_the_llm(
    editor_client: TestClient, api_store: Store, send: Send, capsys: pytest.CaptureFixture[str]
) -> None:
    queued = queue(api_store, "chutney")

    failed = run(BASE_URL, send, fake_browser({queued.source.url: rendered()}))  # pyright: ignore[reportAttributeAccessIssue]

    assert failed == 0
    printed = capsys.readouterr()
    packet = json.loads(printed.out)
    assert packet["items"] == [{"id": queued.id, "url": f"{SITE}/chutney", "text": TEXT}]
    assert "untrusted" in packet["instructions"]
    assert "not instructions" in packet["instructions"]
    assert "Saved 0, 1 for the LLM, 0 need their page, 0 failed" in printed.err
    assert queue_state(editor_client) == {queued.id: ("waiting", "no_recipe")}


def test_run_marks_a_source_with_no_page_text_as_needing_its_page(
    editor_client: TestClient, api_store: Store, send: Send, capsys: pytest.CaptureFixture[str]
) -> None:
    refused = queue(api_store, "refused")
    missing = queue(api_store, "missing")
    pages: dict[str, RenderedPage | Exception] = {
        f"{SITE}/refused": FetchRefused(reason="robots"),
        f"{SITE}/missing": PageNotFound("gone"),
    }

    assert run(BASE_URL, send, fake_browser(pages)) == 0

    assert queue_state(editor_client) == {
        refused.id: ("needs_page", "robots"),
        missing.id: ("needs_page", "unreachable"),
    }
    assert "Saved 0, 0 for the LLM, 2 need their page, 0 failed" in capsys.readouterr().err


def test_run_takes_only_waiting_website_sources(
    editor_client: TestClient, api_store: Store, send: Send
) -> None:
    queue(api_store, "needs-a-page", state="needs_page")
    sheet = queue(api_store, "sheet").model_copy(
        update={
            "id": new_ulid(),
            "dedupe_key": "sheet/row",
            "source": SpreadsheetSource(
                url=f"{SITE}/a-sheet",
                sheet_id="sheet",
                entry_name="row",
                captured_at=datetime(2026, 10, 1, tzinfo=UTC),
            ),
        }
    )
    api_store.queue_ingest(sheet)
    asked: list[str] = []

    def fetch(url: str) -> RenderedPage:
        asked.append(url)
        return rendered()

    assert run(BASE_URL, send, fetch) == 0

    assert asked == [f"{SITE}/sheet"]


def test_a_failure_on_one_source_never_stops_the_others(
    editor_client: TestClient, api_store: Store, send: Send, capsys: pytest.CaptureFixture[str]
) -> None:
    crashed = queue(api_store, "crashed")
    refused = queue(api_store, "api-fails")
    fine = queue(api_store, "fine")
    pages: dict[str, RenderedPage | Exception] = {
        f"{SITE}/crashed": RuntimeError("the browser went away"),
        f"{SITE}/api-fails": FetchRefused(reason="robots"),
        f"{SITE}/fine": rendered(RECIPE),
    }

    def flaky(method: str, url: str, body: bytes | None) -> tuple[int, Any]:
        if refused.id in url:
            return 500, "Server trouble"
        return send(method, url, body)

    failed = run(BASE_URL, flaky, fake_browser(pages))

    assert failed == 2
    assert only_recipe(editor_client)["source"]["url"] == fine.source.url  # pyright: ignore[reportAttributeAccessIssue]
    assert queue_state(editor_client) == {
        crashed.id: ("waiting", "no_recipe"),
        refused.id: ("waiting", "no_recipe"),
    }
    printed = capsys.readouterr().err
    assert "the browser went away" in printed
    assert "Server trouble" in printed
    assert "Saved 1, 0 for the LLM, 0 need their page, 2 failed" in printed


def test_a_temporary_failure_records_its_reason_and_the_next_run_retries_it(
    editor_client: TestClient, api_store: Store, send: Send, capsys: pytest.CaptureFixture[str]
) -> None:
    limited = queue(api_store, "limited")
    erroring = queue(api_store, "erroring")
    offline = queue(api_store, "offline")
    fine = queue(api_store, "fine")
    pages: dict[str, RenderedPage | Exception | int] = {
        f"{SITE}/limited": IngestFailed(reason="rate_limited"),
        f"{SITE}/erroring": 503,
        f"{SITE}/offline": IngestFailed(reason="unreachable"),
        f"{SITE}/fine": rendered(RECIPE),
    }

    failed = run(BASE_URL, send, fake_browser(pages))

    assert failed == 0
    assert only_recipe(editor_client)["source"]["url"] == fine.source.url  # pyright: ignore[reportAttributeAccessIssue]
    assert queue_state(editor_client) == {
        limited.id: ("waiting", "rate_limited"),
        erroring.id: ("waiting", "server_error"),
        offline.id: ("waiting", "unreachable"),
    }
    printed = capsys.readouterr()
    assert json.loads(printed.out)["items"] == []
    assert f"{SITE}/limited → still waiting (rate_limited)" in printed.err
    assert "Saved 1, 0 for the LLM, 0 need their page, 0 failed, 3 still waiting" in printed.err

    pages[f"{SITE}/limited"] = rendered(NO_RECIPE)

    assert run(BASE_URL, send, fake_browser(pages)) == 0

    assert [item["id"] for item in json.loads(capsys.readouterr().out)["items"]] == [limited.id]


def test_a_whole_queue_hitting_dns_failure_stays_waiting_as_unreachable(
    api_store: Store, send: Send, capsys: pytest.CaptureFixture[str]
) -> None:
    queued = [queue(api_store, f"page-{n}", site=f"https://site-{n}.test") for n in range(3)]
    written: list[str] = []

    def nothing_resolves(_host: str) -> list[str]:
        raise socket.gaierror(socket.EAI_NONAME, "Name or service not known")

    def fetch(url: str) -> RenderedPage:
        PoliteFetcher(resolve=nothing_resolves).refuse_unless_public(url)
        raise AssertionError(url)

    def recording(method: str, url: str, body: bytes | None) -> tuple[int, Any]:
        if method != "GET":
            written.append(url)
        return send(method, url, body)

    assert run(BASE_URL, recording, fetch) == 0

    assert written == [f"{BASE_URL}/api/queued-ingests/{q.id}/failed-attempt" for q in queued]
    assert api_store.queued_ingests() == [
        q.model_copy(update={"reason": "unreachable"}) for q in queued
    ]
    printed = capsys.readouterr()
    assert json.loads(printed.out)["items"] == []
    assert "Saved 0, 0 for the LLM, 0 need their page, 0 failed, 3 still waiting" in printed.err


def test_a_failed_attempt_the_api_refuses_fails_that_source_alone(
    editor_client: TestClient, api_store: Store, send: Send, capsys: pytest.CaptureFixture[str]
) -> None:
    limited = queue(api_store, "limited")
    offline = queue(api_store, "offline")
    pages = {f"{SITE}/limited": 429, f"{SITE}/offline": IngestFailed(reason="unreachable")}

    def flaky(method: str, url: str, body: bytes | None) -> tuple[int, Any]:
        if limited.id in url:
            return 500, "Server trouble"
        return send(method, url, body)

    assert run(BASE_URL, flaky, fake_browser(pages)) == 1

    assert queue_state(editor_client) == {
        limited.id: ("waiting", "no_recipe"),
        offline.id: ("waiting", "unreachable"),
    }
    printed = capsys.readouterr().err
    assert f"{SITE}/limited → failed: 500 Server trouble" in printed
    assert "Saved 0, 0 for the LLM, 0 need their page, 1 failed, 1 still waiting" in printed


def test_run_says_so_when_the_queue_cannot_be_listed(capsys: pytest.CaptureFixture[str]) -> None:
    def refuse(_method: str, _url: str, _body: bytes | None) -> tuple[int, Any]:
        return 403, "No"

    assert run(BASE_URL, refuse, fake_browser({})) == 1

    printed = capsys.readouterr()
    assert printed.out == ""
    assert "Couldn't list the Queued Ingests: 403 No" in printed.err


# apply


def test_an_llm_original_is_saved_as_the_llms_and_stops_at_awaiting_review(
    editor_client: TestClient, api_store: Store, send: Send, capsys: pytest.CaptureFixture[str]
) -> None:
    """From a Work Packet through apply and enrichment, as the CLIs run it."""
    queued = queue(api_store, "chutney")
    assert run(BASE_URL, send, fake_browser({f"{SITE}/chutney": rendered()})) == 0
    packet = capsys.readouterr().out

    failed = apply(BASE_URL, send, packet, answer_of((queued, original(extractor="sneaky"))))

    assert failed == 0
    recipe = only_recipe(editor_client)
    assert recipe["original"]["extractor"] == LLM_EXTRACTOR
    assert recipe["original"]["title"] == "Plum Chutney"
    assert [line["text"] for line in recipe["original"]["ingredients"]] == [
        "2 plums, chopped",
        "1 cup sugar",
    ]
    assert recipe["status"] == "pending"
    assert queue_state(editor_client) == {}
    assert "Saved 1, 0 need their page, 0 failed" in capsys.readouterr().err

    offered = work_packet(send, capsys)
    answered: list[dict[str, Any]] = [
        {"recipe_id": r["recipe_id"], "offer_id": r["offer_id"], "lines": []}
        for r in offered["recipes"]
    ]
    answer = json.dumps({"model": "a-model", "recipes": answered})
    assert enrich.apply(BASE_URL, send, SNAPSHOT, answer) == 0

    assert stored(editor_client, recipe["id"])["status"] == "awaiting_review"


def test_whitespace_differences_do_not_fail_the_verbatim_check(
    editor_client: TestClient, api_store: Store, send: Send
) -> None:
    queued = queue(api_store, "chutney")
    answered = original(
        ingredients=[{"id": "i1", "text": " 1 cup\nsugar "}],
        steps=[{"id": "s1", "text": "Simmer the plums\t with the sugar."}],
    )

    assert apply(BASE_URL, send, packet_of(queued), answer_of((queued, answered))) == 0

    assert only_recipe(editor_client)["original"]["extractor"] == LLM_EXTRACTOR


def test_a_null_answer_needs_its_page_as_no_recipe(
    editor_client: TestClient, api_store: Store, send: Send
) -> None:
    queued = queue(api_store, "chutney")

    assert apply(BASE_URL, send, packet_of(queued), answer_of((queued, None))) == 0

    assert queue_state(editor_client) == {queued.id: ("needs_page", "no_recipe")}


@pytest.mark.parametrize(
    ("fields", "why"),
    [
        ({"title": "Damson Chutney"}, "The title isn't on the page: 'Damson Chutney'"),
        (
            {"ingredients": [{"id": "i1", "text": "3 plums, chopped"}]},
            "An ingredient isn't on the page: '3 plums, chopped'",
        ),
        (
            {"steps": [{"id": "s1", "text": "Boil the plums."}]},
            "A step isn't on the page: 'Boil the plums.'",
        ),
        (
            {"description": "A jammy autumn favourite."},
            "The description isn't on the page: 'A jammy autumn favourite.'",
        ),
        ({"author": "A Famous Chef"}, "The author isn't on the page: 'A Famous Chef'"),
        ({"yield": {"text": "Makes 6 jars"}}, "The yield isn't on the page: 'Makes 6 jars'"),
        (
            {"stated_times": {"prep": {"text": "5 minutes"}}},
            "The prep time isn't on the page: '5 minutes'",
        ),
        (
            {"stated_times": {"cook": {"text": "2 hours"}}},
            "The cook time isn't on the page: '2 hours'",
        ),
        (
            {"stated_times": {"total": {"text": "3 hours"}}},
            "The total time isn't on the page: '3 hours'",
        ),
        ({"description": ""}, "The description isn't on the page: ''"),
        ({"title": "Plum Chut"}, "The title isn't on the page: 'Plum Chut'"),
        ({"title": "plum chutney"}, "The title isn't on the page: 'plum chutney'"),
        ({"steps": []}, "It has no steps"),
        ({"title": "   "}, "The title isn't on the page: '   '"),
        ({"steps": [{"id": "s1", "text": ""}]}, "A step isn't on the page: ''"),
        ({"ingredients": []}, "It has no ingredients"),
        (
            {
                "ingredients": [
                    {"id": "i1", "text": "1 cup sugar"},
                    {"id": "i1", "text": "2 plums, chopped"},
                ]
            },
            "Two lines share an id",
        ),
        ({"ingredients": "plums"}, "Input should be a valid list"),
    ],
)
def test_an_original_not_on_the_page_prints_why_and_needs_its_page(
    editor_client: TestClient,
    api_store: Store,
    capsys: pytest.CaptureFixture[str],
    fields: dict[str, Any],
    why: str,
) -> None:
    queued = queue(api_store, "chutney")
    send = through(api(editor_client))

    failed = apply(BASE_URL, send, packet_of(queued), answer_of((queued, original(**fields))))

    assert failed == 1
    assert why in capsys.readouterr().err
    assert queue_state(editor_client) == {queued.id: ("needs_page", "no_recipe")}
    assert editor_client.get("/api/collection", follow_redirects=True).json()["cards"] == []


def test_a_packet_whose_answers_are_all_rejected_counts_them_as_needing_their_page(
    editor_client: TestClient, api_store: Store, send: Send, capsys: pytest.CaptureFixture[str]
) -> None:
    first = queue(api_store, "first")
    second = queue(api_store, "second")
    wrong = original(title="Damson Chutney")

    failed = apply(
        BASE_URL, send, packet_of(first, second), answer_of((first, wrong), (second, wrong))
    )

    assert failed == 2
    assert "Saved 0, 2 need their page, 2 failed" in capsys.readouterr().err
    assert queue_state(editor_client) == {
        first.id: ("needs_page", "no_recipe"),
        second.id: ("needs_page", "no_recipe"),
    }


def test_a_rejected_answer_whose_needs_page_mark_is_refused_counts_as_one_failure(
    editor_client: TestClient, api_store: Store, send: Send, capsys: pytest.CaptureFixture[str]
) -> None:
    rejected = queue(api_store, "rejected")

    def refuse_the_mark(method: str, url: str, body: bytes | None) -> tuple[int, Any]:
        if url.endswith("/needs-page"):
            return 404, "No such Queued Ingest"
        return send(method, url, body)

    failed = apply(
        BASE_URL,
        refuse_the_mark,
        packet_of(rejected),
        answer_of((rejected, original(title="Damson Chutney"))),
    )

    assert failed == 1
    assert "Saved 0, 0 need their page, 1 failed" in capsys.readouterr().err
    assert queue_state(editor_client) == {rejected.id: ("waiting", "no_recipe")}


@pytest.mark.parametrize(
    ("rejected", "summary"),
    [
        ([original(title="Damson Chutney")], "Saved 1, 2 need their page, 1 failed"),
        ([], "Saved 1, 1 need their page, 0 failed"),
    ],
)
def test_a_mix_of_answers_counts_null_and_rejected_as_needing_their_page(
    api_store: Store,
    send: Send,
    capsys: pytest.CaptureFixture[str],
    rejected: list[dict[str, Any]],
    summary: str,
) -> None:
    saved = queue(api_store, "saved")
    null = queue(api_store, "null")
    wrong = queue(api_store, "wrong")
    answers = [(saved, original()), (null, None), *((wrong, a) for a in rejected)]

    failed = apply(BASE_URL, send, packet_of(saved, null, wrong), answer_of(*answers))

    assert failed == len(rejected)
    assert summary in capsys.readouterr().err


def test_an_original_quoting_everything_on_the_page_is_saved_with_its_numbers_unchecked(
    editor_client: TestClient, api_store: Store, send: Send
) -> None:
    queued = queue(api_store, "chutney")
    answered = original(
        description="A line of the page's own chatter.",
        author="a test cook",
        stated_times={
            "prep": {"text": "10 minutes", "seconds": 111},
            "cook": {"text": "1 hour", "seconds": 222},
            "total": {"text": "70 minutes", "seconds": 333},
        },
        **{"yield": {"text": "Makes 2 jars", "servings": 99}},
    )

    assert (
        apply(BASE_URL, send, packet_of(queued, text=FULL_TEXT), answer_of((queued, answered))) == 0
    )

    saved = only_recipe(editor_client)["original"]
    assert saved["author"] == "a test cook"
    assert saved["yield"]["servings"] == 99
    assert saved["stated_times"]["total"]["seconds"] == 333


@pytest.mark.parametrize(
    ("quote", "text"),
    [
        ("Warm", "Warmth of the stove"),
        ("oil", "Bring to a boil"),
        ("2 plums", "12 plums"),
        ("1/2 cup", "1/2 cups"),
        ("1/2 cup (120 ml)", "11/2 cup (120 ml) milk"),
        ("1/2 cup (120 ml)", "1/2 cup (120 ml)milk"),
        ("(120 ml) milk", "cup(120 ml) milk"),
    ],
)
def test_a_quote_with_a_word_character_beside_it_isnt_on_the_page(quote: str, text: str) -> None:
    assert f"The title isn't on the page: {quote!r}" in verbatim_errors(an_original(quote), text)


@pytest.mark.parametrize(
    ("quote", "text"),
    [
        ("Warm", "Warm"),
        ("Warm", "Warm the pot."),
        ("oil", "Bring to a boil, then add the oil."),
        ("salt", "2 tsp sea salt, to taste"),
        ("1/2 cup (120 ml)", "1/2 cup (120 ml)"),
        ("1/2 cup (120 ml)", "Add 1/2 cup (120 ml) milk."),
        ("1/2 cup (120 ml)", "(1/2 cup (120 ml))"),
        ("(120 ml) milk", "1/2 cup (120 ml) milk"),
        ("Serve cold.", "Simmer. Serve cold. Enjoy."),
        ("2 plums, chopped 1 cup sugar", "2 plums, chopped\n1 cup sugar"),
    ],
)
def test_a_quote_on_word_boundaries_is_on_the_page(quote: str, text: str) -> None:
    assert verbatim_errors(an_original(quote), text) == []


def test_a_capture_without_steps_is_still_saved_by_run(
    editor_client: TestClient, api_store: Store, send: Send
) -> None:
    queued = queue(api_store, "soup")
    no_steps = re.sub(r'"recipeInstructions": \[.*?\],', "", RECIPE, flags=re.DOTALL)

    assert run(BASE_URL, send, fake_browser({queued.source.url: rendered(no_steps)})) == 0  # pyright: ignore[reportAttributeAccessIssue]

    assert only_recipe(editor_client)["original"]["steps"] == []


def test_the_check_is_against_that_items_own_text(
    editor_client: TestClient, api_store: Store, send: Send
) -> None:
    chutney = queue(api_store, "chutney")
    other = queue(api_store, "other")
    packet = json.dumps(
        {
            "instructions": "Any",
            "items": [
                {"id": chutney.id, "url": f"{SITE}/chutney", "text": TEXT},
                {"id": other.id, "url": f"{SITE}/other", "text": "Nothing like it"},
            ],
        }
    )

    assert apply(BASE_URL, send, packet, answer_of((other, original()))) == 1

    assert queue_state(editor_client)[other.id] == ("needs_page", "no_recipe")


def test_an_answer_for_something_the_packet_never_held_touches_nothing(
    editor_client: TestClient, api_store: Store, send: Send, capsys: pytest.CaptureFixture[str]
) -> None:
    queued = queue(api_store, "chutney")

    assert apply(BASE_URL, send, packet_of(), answer_of((queued, original()))) == 1

    assert "isn't in the packet" in capsys.readouterr().err
    assert queue_state(editor_client) == {queued.id: ("waiting", "no_recipe")}


def test_an_answer_for_a_source_no_longer_queued_is_skipped_and_the_rest_go_on(
    editor_client: TestClient, api_store: Store, send: Send, capsys: pytest.CaptureFixture[str]
) -> None:
    gone = queue(api_store, "gone")
    kept = queue(api_store, "kept")
    packet = packet_of(gone, kept)
    assert apply(BASE_URL, send, packet_of(gone), answer_of((gone, original()))) == 0

    failed = apply(BASE_URL, send, packet, answer_of((gone, original()), (kept, None)))

    assert failed == 1
    assert "no longer queued" in capsys.readouterr().err
    assert queue_state(editor_client) == {kept.id: ("needs_page", "no_recipe")}


def test_a_failure_on_one_answer_never_stops_the_others(
    editor_client: TestClient, api_store: Store, send: Send, capsys: pytest.CaptureFixture[str]
) -> None:
    refused = queue(api_store, "api-fails")
    fine = queue(api_store, "fine")
    also_fine = queue(api_store, "also-fine")

    def flaky(method: str, url: str, body: bytes | None) -> tuple[int, Any]:
        if refused.id in url:
            return 500, "Server trouble"
        return send(method, url, body)

    failed = apply(
        BASE_URL,
        flaky,
        packet_of(refused, fine, also_fine),
        answer_of((refused, original()), (fine, original()), (also_fine, original())),
    )

    assert failed == 1
    assert len(editor_client.get("/api/collection", follow_redirects=True).json()["cards"]) == 2
    assert queue_state(editor_client) == {refused.id: ("waiting", "no_recipe")}
    printed = capsys.readouterr().err
    assert "Server trouble" in printed
    assert "Saved 2, 0 need their page, 1 failed" in printed


@pytest.mark.parametrize(
    ("packet", "answer"),
    [("not json", '{"answers": []}'), ('{"items": []}', '{"answers": [{"original": null}]}')],
)
def test_files_that_are_not_a_packet_and_answer_write_nothing(
    packet: str, answer: str, capsys: pytest.CaptureFixture[str]
) -> None:
    def no_requests(_method: str, _url: str, _body: bytes | None) -> tuple[int, Any]:
        raise AssertionError

    assert apply(BASE_URL, no_requests, packet, answer) == 1

    assert "isn't a" in capsys.readouterr().err


# Never stored


def test_no_request_to_the_api_carries_a_pages_html(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    adapter = api(editor_client)
    send = through(adapter)
    queue(api_store, "saved")
    needs_llm = queue(api_store, "needs-llm")
    queue(api_store, "no-text")
    queue(api_store, "refused")
    secret = "<!-- markup only the HTML holds -->"
    pages: dict[str, RenderedPage | Exception] = {
        f"{SITE}/saved": rendered(RECIPE.replace("</body>", f"{secret}</body>")),
        f"{SITE}/needs-llm": rendered(NO_RECIPE.replace("</body>", f"{secret}</body>")),
        f"{SITE}/no-text": rendered(NO_RECIPE.replace("</body>", f"{secret}</body>"), text=""),
        f"{SITE}/refused": FetchRefused(reason="robots"),
    }

    assert run(BASE_URL, send, fake_browser(pages)) == 0
    printed = capsys.readouterr().out
    assert apply(BASE_URL, send, printed, answer_of((needs_llm, original()))) == 0

    writes = [_body(r) for r in adapter.requests if r.method == "POST"]
    assert len(writes) >= 4
    for body in [*writes, printed]:
        assert "<html" not in body
        assert "<script" not in body
        assert "ld+json" not in body
        assert "markup only" not in body
        assert "Page text that is never stored" not in body


def _body(request: PreparedRequest) -> str:
    body = request.body
    return body.decode() if isinstance(body, bytes) else str(body)


def test_nothing_but_the_packet_goes_to_stdout_and_no_file_is_written(
    api_store: Store,
    send: Send,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.chdir(tmp_path)
    queue(api_store, "chutney")

    assert run(BASE_URL, send, fake_browser({f"{SITE}/chutney": rendered()})) == 0

    assert json.loads(capsys.readouterr().out)["items"]
    assert list(tmp_path.iterdir()) == []


# The commands


def test_main_refuses_a_plain_http_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PLATEFUL_SERVICE_TOKEN", SERVICE_TOKEN)

    with pytest.raises(SystemExit, match="must be https"):
        main(["run", "http://plateful.example"])


def test_main_needs_the_service_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PLATEFUL_SERVICE_TOKEN", raising=False)

    with pytest.raises(SystemExit, match="PLATEFUL_SERVICE_TOKEN"):
        main(["run", "https://plateful.example"])


@pytest.fixture
def through_the_api(send: Send, monkeypatch: pytest.MonkeyPatch) -> None:
    """Points the CLI's own transport at the in-process API."""
    monkeypatch.setenv("PLATEFUL_SERVICE_TOKEN", SERVICE_TOKEN)

    def send_with(_session: object, _token: str) -> Send:
        return send

    monkeypatch.setattr(fallback, "send_with", send_with)


@pytest.mark.parametrize(
    ("second", "code"),
    [(rendered(RECIPE), 0), (RuntimeError("the browser went away"), 1)],
)
@pytest.mark.usefixtures("through_the_api")
def test_main_runs_the_chain_and_exits_1_only_when_a_source_failed(
    editor_client: TestClient,
    api_store: Store,
    monkeypatch: pytest.MonkeyPatch,
    second: RenderedPage | Exception,
    code: int,
) -> None:
    queue(api_store, "first")
    queue(api_store, "second")
    fetch = fake_browser({f"{SITE}/first": rendered(RECIPE), f"{SITE}/second": second})
    monkeypatch.setattr(fallback, "BrowserFetcher", lambda: nullcontext(fetch))

    with pytest.raises(SystemExit) as exited:
        main(["run", "https://plateful.example"])

    assert exited.value.code == code
    saved = editor_client.get("/api/collection", follow_redirects=True).json()["cards"]
    assert len(saved) == 2 - code


@pytest.mark.usefixtures("through_the_api")
def test_main_applies_an_answer_from_stdin(
    editor_client: TestClient,
    api_store: Store,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Any,
) -> None:
    queued = queue(api_store, "chutney")
    packet = tmp_path / "packet.json"
    packet.write_text(packet_of(queued))
    monkeypatch.setattr("sys.stdin", io.StringIO(answer_of((queued, None))))

    with pytest.raises(SystemExit) as exited:
        main(["apply", "https://plateful.example", str(packet), "-"])

    assert exited.value.code == 0
    assert queue_state(editor_client) == {queued.id: ("needs_page", "no_recipe")}
