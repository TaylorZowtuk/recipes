"""The enrich CLI parses each Pending recipe's lines and writes the facts through the API."""

import hashlib
import io
from typing import TYPE_CHECKING, Any

import pytest
from conftest import SERVICE_TOKEN
from requests.adapters import BaseAdapter
from requests.models import PreparedRequest, Response
from requests.structures import CaseInsensitiveDict

from recipes.auth import SERVICE_TOKEN_HEADER
from recipes.enrich import (
    ENRICHMENT_VERSION,
    SameOriginSession,
    Send,
    checked_base_url,
    main,
    run,
    send_with,
)
from recipes.models import (
    MAX_LABEL,
    SCHEMA_VERSION,
    IngestChannel,
    IngredientLine,
    Original,
    Recipe,
    WebsiteSource,
    new_ulid,
)

if TYPE_CHECKING:
    from collections.abc import Callable

    from fastapi.testclient import TestClient

    from recipes.store import Store

BASE_URL = "http://testserver"
# Answers a request with its status, headers and body.
type Handler = Callable[[PreparedRequest], tuple[int, dict[str, str], bytes]]


class Adapter(BaseAdapter):
    """Answers the CLI's requests with `handle` in place of the network, keeping each one."""

    def __init__(self, handle: Handler) -> None:
        super().__init__()
        self.handle = handle
        self.requests: list[PreparedRequest] = []

    def send(self, request: PreparedRequest, *_args: Any, **_kwargs: Any) -> Response:
        self.requests.append(request)
        status, headers, body = self.handle(request)
        response = Response()
        response.status_code = status
        response.headers = CaseInsensitiveDict(headers)
        response.raw = io.BytesIO(body)
        response.url = request.url or ""
        response.request = request
        return response

    def close(self) -> None:
        pass


def through(adapter: Adapter) -> Send:
    """The CLI's own transport, sending through `adapter`."""
    session = SameOriginSession()
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return send_with(session, SERVICE_TOKEN)


def api(client: TestClient) -> Adapter:
    """Sends each request to the in-process API."""

    def handle(request: PreparedRequest) -> tuple[int, dict[str, str], bytes]:
        body = request.body.encode() if isinstance(request.body, str) else request.body
        response = client.request(
            request.method or "GET", request.url or "", headers=request.headers, content=body
        )
        return response.status_code, dict(response.headers), response.content

    return Adapter(handle)


def add(
    store: Store,
    title: str,
    status: str = "pending",
    channel: IngestChannel | None = "add_a_recipe",
    lines: list[IngredientLine] | None = None,
) -> Recipe:
    slug = title.lower().replace(" ", "-")
    lines = lines or [
        IngredientLine(id="i1", component="For the marinade", text="2 tbsp soy sauce"),
        IngredientLine(id="i2", component="For the marinade", text="3 cloves garlic, minced"),
        IngredientLine(id="i3", component="For the sauce", text="1-2 tsp chili oil, or to taste"),
        IngredientLine(id="i4", component="For the sauce", text="salt, to taste"),
    ]
    recipe = Recipe(
        id=new_ulid(),
        schema_version=SCHEMA_VERSION,
        version=1,
        source=WebsiteSource(
            url=f"https://example.com/{slug}",
            site_name="Example Kitchen",
            captured_at="2026-09-01T12:00:00Z",  # pyright: ignore[reportArgumentType]
        ),
        dedupe_key=f"https://example.com/{slug}",
        original=Original(title=title, extractor="json-ld", ingredients=lines, steps=[]),
        status=status,  # pyright: ignore[reportArgumentType]
        ingest_channel=channel,
    )
    return store.add_recipe(recipe)


def stored(client: TestClient, recipe_id: str) -> dict[str, Any]:
    return client.get(f"/api/recipes/{recipe_id}", follow_redirects=True).json()


def test_a_pending_recipe_gets_a_parse_fact_for_every_line_across_its_components(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = add(api_store, "Garlic Tofu")

    failed = run(BASE_URL, through(api(editor_client)))

    assert failed == 0
    enriched = stored(editor_client, recipe.id)
    assert enriched["status"] == "awaiting_review"
    assert enriched["enrichment_version"] == ENRICHMENT_VERSION
    facts = enriched["facts"]["ingredients"]
    assert sorted(facts) == ["i1", "i2", "i3", "i4"]
    chili = facts["i3"]["parse"]
    assert chili["quantity"] == {"low": 1, "high": 2}
    assert (chili["unit"], chili["unit_kind"], chili["name"]) == ("tsp", "volume", "chili oil")
    assert chili["comment"] == "or to taste"
    assert facts["i2"]["parse"]["preparation"] == "minced"
    assert facts["i4"]["parse"]["quantity"] is None
    for fact in facts.values():
        parse = fact["parse"]
        assert (parse["provenance"], parse["estimated"], parse["confirmed"]) == (
            "parser",
            False,
            False,
        )
        assert (parse["confirmed_by"], parse["confirmed_at"]) == (None, None)
        assert 0 < parse["confidence"] <= 1


def test_a_bulk_import_recipe_goes_straight_to_ready(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = add(api_store, "Bulk Curry", channel="bulk_import")

    run(BASE_URL, through(api(editor_client)))

    assert stored(editor_client, recipe.id)["status"] == "ready"


def test_recipes_that_are_not_pending_are_left_alone(
    editor_client: TestClient, api_store: Store
) -> None:
    ready = add(api_store, "Ready Stew", status="ready")
    awaiting = add(api_store, "Awaiting Soup", status="awaiting_review")
    adapter = api(editor_client)

    failed = run(BASE_URL, through(adapter))

    assert failed == 0
    assert stored(editor_client, ready.id) == ready.model_dump(mode="json")
    assert stored(editor_client, awaiting.id) == awaiting.model_dump(mode="json")
    assert {request.method for request in adapter.requests} == {"GET"}


def test_every_request_carries_the_service_token_and_writes_their_bodys_sha256(
    editor_client: TestClient, api_store: Store
) -> None:
    add(api_store, "Garlic Tofu")
    adapter = api(editor_client)

    run(BASE_URL, through(adapter))

    assert all(r.headers[SERVICE_TOKEN_HEADER] == SERVICE_TOKEN for r in adapter.requests)
    writes = [request for request in adapter.requests if request.method == "PUT"]
    assert len(writes) == 1
    body = writes[0].body
    assert isinstance(body, bytes)
    assert writes[0].headers["x-amz-content-sha256"] == hashlib.sha256(body).hexdigest()
    assert writes[0].headers["content-type"] == "application/json"


def test_a_recipe_that_fails_is_reported_and_the_run_goes_on(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    first = add(api_store, "Garlic Tofu")
    second = add(api_store, "Chili Noodles")
    send = through(api(editor_client))

    def enrich_first_meanwhile(method: str, url: str, body: bytes | None) -> tuple[int, Any]:
        # Someone else enriches the first recipe between the CLI's read and its write.
        if method == "PUT" and first.id in url:
            send("PUT", url, body)
        return send(method, url, body)

    failed = run(BASE_URL, enrich_first_meanwhile)

    assert failed == 1
    assert stored(editor_client, second.id)["status"] == "awaiting_review"
    out = capsys.readouterr().out
    assert "Garlic Tofu" in out
    assert "409" in out
    assert "Chili Noodles → awaiting_review" in out


def test_a_collection_the_cli_cant_list_fails_the_run_and_writes_nothing() -> None:
    # The API lists the Collection to anyone, so the 403 is CloudFront's, as for a blocked IP.
    adapter = Adapter(lambda _: (403, {"content-type": "application/json"}, b'{"message": "no"}'))

    failed = run("https://plateful.example", through(adapter))

    assert failed != 0
    assert [request.url for request in adapter.requests] == [
        "https://plateful.example/api/collection"
    ]


@pytest.mark.parametrize(
    "text", ["", "   ", "x" * 300], ids=["empty", "whitespace", "300 characters"]
)
def test_a_line_the_parser_cant_read_leaves_its_recipe_and_the_next_still_enriched(
    editor_client: TestClient, api_store: Store, text: str
) -> None:
    odd = add(
        api_store,
        "Odd Line Stew",
        lines=[IngredientLine(id="i1", text=text), IngredientLine(id="i2", text="2 eggs")],
    )
    after = add(api_store, "Garlic Tofu")

    failed = run(BASE_URL, through(api(editor_client)))

    assert failed == 0
    enriched = stored(editor_client, odd.id)
    assert enriched["status"] == "awaiting_review"
    facts = enriched["facts"]["ingredients"]
    assert "i2" in facts
    # A line too blank to parse has no fact, and the tab shows its text as written.
    assert ("i1" in facts) == bool(text.strip())
    assert all(len(fact["parse"]["name"]) <= MAX_LABEL for fact in facts.values())
    assert stored(editor_client, after.id)["status"] == "awaiting_review"


def redirect_to(location: str) -> Adapter:
    """Redirects the first request to `location`, and answers any other with an empty JSON body."""

    def handle(request: PreparedRequest) -> tuple[int, dict[str, str], bytes]:
        if request.url == "https://plateful.example/api/collection":
            return 307, {"location": location}, b""
        return 200, {"content-type": "application/json"}, b"{}"

    return Adapter(handle)


def test_a_redirect_on_the_same_host_is_followed_with_the_token() -> None:
    adapter = redirect_to("/api/v/collection/3")

    status, _ = through(adapter)("GET", "https://plateful.example/api/collection", None)

    assert status == 200
    assert [request.url for request in adapter.requests][-1] == (
        "https://plateful.example/api/v/collection/3"
    )
    assert adapter.requests[-1].headers[SERVICE_TOKEN_HEADER] == SERVICE_TOKEN


@pytest.mark.parametrize(
    "location",
    ["https://elsewhere.example/api/v/collection/3", "http://plateful.example/api/v/collection/3"],
    ids=["another host", "plain http"],
)
def test_a_redirect_off_the_base_urls_scheme_and_host_is_not_followed(location: str) -> None:
    adapter = redirect_to(location)

    status, _ = through(adapter)("GET", "https://plateful.example/api/collection", None)

    assert status == 307
    assert len(adapter.requests) == 1


@pytest.mark.parametrize(
    "url",
    [
        "https://d111111abcdef8.cloudfront.net",
        "http://localhost:5173",
        "http://127.0.0.1:8787",
        "http://api:8787/",
    ],
)
def test_https_or_a_local_dev_host_is_a_base_url(url: str) -> None:
    assert checked_base_url(url) == url.rstrip("/")


@pytest.mark.parametrize(
    "url", ["http://d111111abcdef8.cloudfront.net", "ftp://localhost", "localhost:5173"]
)
def test_any_other_base_url_is_refused_before_the_token_is_sent(url: str) -> None:
    with pytest.raises(SystemExit, match="https"):
        checked_base_url(url)


def test_main_without_the_service_token_stops_and_says_so(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("sys.argv", ["enrich", "https://d111111abcdef8.cloudfront.net"])
    monkeypatch.delenv("PLATEFUL_SERVICE_TOKEN", raising=False)

    with pytest.raises(SystemExit, match="PLATEFUL_SERVICE_TOKEN"):
        main()
