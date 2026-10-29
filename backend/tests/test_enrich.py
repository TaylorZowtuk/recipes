"""The enrich CLI hands a model a Work Packet of every Pending recipe, then checks the model's
answer against what the packet offered and writes the facts through the API.
"""

import hashlib
import io
import json
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest
from conftest import SERVICE_TOKEN
from requests.adapters import BaseAdapter
from requests.models import PreparedRequest, Response
from requests.structures import CaseInsensitiveDict

from recipes import fdc
from recipes.auth import SERVICE_TOKEN_HEADER
from recipes.enrich import (
    SameOriginSession,
    Send,
    apply,
    checked_base_url,
    main,
    packet,
    read_answer,
    send_with,
)
from recipes.models import (
    MAX_LABEL,
    SCHEMA_VERSION,
    CanonicalIngredient,
    IngestChannel,
    IngredientLine,
    Original,
    Recipe,
    WebsiteSource,
    Wording,
    new_ulid,
)
from recipes.packet import ENRICHMENT_VERSION

if TYPE_CHECKING:
    from collections.abc import Callable

    from fastapi.testclient import TestClient

    from recipes.store import Store

BASE_URL = "http://testserver"
SNAPSHOT = fdc.load_snapshot(Path(__file__).parent / "fixtures" / "fdc-snapshot.json")
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
        IngredientLine(id="i1", component="For the marinade", text="2 tbsp glimmer oil"),
        IngredientLine(id="i2", component="For the marinade", text="3 cloves snorp garlic, minced"),
        IngredientLine(id="i3", component="For the sauce", text="1-2 quill eggs, or to taste"),
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


def bundle(client: TestClient) -> dict[str, Any]:
    return client.get("/api/collection", follow_redirects=True).json()


def work_packet(send: Send, capsys: pytest.CaptureFixture[str]) -> dict[str, Any]:
    """The packet `enrich packet` prints."""
    assert packet(BASE_URL, send, SNAPSHOT) == 0
    return json.loads(capsys.readouterr().out)


NEW_GLIMMER = {"new": {"name": "glimmer oil", "family": "oil", "store_category_id": "aisles"}}


def oil_line(**fields: Any) -> dict[str, Any]:
    """An answer for "2 tbsp glimmer oil" within the offers: a new canonical, its food and tbsp."""
    return {
        "line_id": "i1",
        "canonical": NEW_GLIMMER,
        "fdc_id": 2004,
        "portion_id": 606,
        **fields,
    }


def answer_text(offered: dict[str, Any], *lines: dict[str, Any]) -> str:
    """A model's answer to the packet: `lines` for every recipe in it."""
    return json.dumps(
        {
            "packet_id": offered["packet_id"],
            "model": "a-model",
            "recipes": [
                {"recipe_id": r["recipe_id"], "lines": list(lines or [oil_line()])}
                for r in offered["recipes"]
            ],
        }
    )


def test_packet_prints_every_pending_recipe_and_writes_nothing(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    pending = add(api_store, "Garlic Tofu")
    add(api_store, "Ready Stew", status="ready")
    adapter = api(editor_client)
    before = bundle(editor_client)

    offered = work_packet(through(adapter), capsys)

    assert {request.method for request in adapter.requests} == {"GET"}
    assert bundle(editor_client) == before
    assert offered["fdc_release"] == SNAPSHOT.release
    assert [r["recipe_id"] for r in offered["recipes"]] == [pending.id]
    lines = offered["recipes"][0]["lines"]
    assert [ln["line_id"] for ln in lines] == ["i1", "i2", "i3", "i4"]
    assert lines[2]["parse"]["quantity"] == {"low": 1, "high": 2}
    assert lines[2]["readable_quantities"] == [1, 2]
    assert [food["fdc_id"] for food in lines[0]["fdc_candidates"]] == [2004]
    assert [c["id"] for c in offered["store_categories"]][:3] == ["household", "produce", "meat"]


def test_apply_writes_each_answered_lines_match_and_conversion_and_learns_its_wording(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    recipe = add(api_store, "Garlic Tofu")
    send = through(api(editor_client))
    offered = work_packet(send, capsys)

    failed = apply(BASE_URL, send, SNAPSHOT, answer_text(offered))

    assert failed == 0
    assert "Garlic Tofu → awaiting_review" in capsys.readouterr().out
    enriched = stored(editor_client, recipe.id)
    assert enriched["enrichment_version"] == ENRICHMENT_VERSION == 2
    assert enriched["fdc_release"] == SNAPSHOT.release
    facts = enriched["facts"]["ingredients"]
    assert sorted(facts) == ["i1", "i2", "i3", "i4"]
    chili = facts["i3"]["parse"]
    assert (chili["quantity"], chili["name"], chili["comment"]) == (
        {"low": 1, "high": 2},
        "quill eggs",
        "or to taste",
    )
    assert facts["i2"]["match"] is None
    (created,) = bundle(editor_client)["canonical_ingredients"]
    assert (created["name"], created["family"], created["store_category_id"]) == (
        "glimmer oil",
        "oil",
        "aisles",
    )
    oil = facts["i1"]
    assert oil["match"]["provenance"] == "llm"
    assert (oil["match"]["canonical_id"], oil["match"]["fdc_id"]) == (created["id"], 2004)
    assert oil["conversion"]["provenance"] == "fdc"
    assert oil["conversion"]["density_g_per_ml"] == pytest.approx(13.5 / 14.78676478125)
    assert oil["conversion"]["per_100g"]["kcal"] == 884
    assert [
        (w["wording"], w["canonical_id"], w["confirmed"]) for w in bundle(editor_client)["wordings"]
    ] == [("glimmer oil", created["id"], False)]
    (issue,) = enriched["issues"]
    assert issue["reason"] == "new Canonical Ingredient glimmer oil (oil, Aisles)"


def test_a_new_canonical_named_in_two_recipes_is_created_once(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    first = add(api_store, "Garlic Tofu")
    second = add(api_store, "Chili Noodles")
    send = through(api(editor_client))

    failed = apply(BASE_URL, send, SNAPSHOT, answer_text(work_packet(send, capsys)))

    assert failed == 0
    (created,) = bundle(editor_client)["canonical_ingredients"]
    for recipe in (first, second):
        match = stored(editor_client, recipe.id)["facts"]["ingredients"]["i1"]["match"]
        assert match["canonical_id"] == created["id"]


def test_the_answer_is_read_from_a_file_or_stdin(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "answer.json"
    path.write_text('{"from": "file"}')
    monkeypatch.setattr("sys.stdin", io.StringIO('{"from": "stdin"}'))

    assert read_answer(str(path)) == '{"from": "file"}'
    assert read_answer("-") == '{"from": "stdin"}'


def test_a_stale_packet_is_rejected_and_nothing_is_written(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    recipe = add(api_store, "Garlic Tofu")
    adapter = api(editor_client)
    offered = work_packet(through(adapter), capsys)
    add(api_store, "Chili Noodles")  # the Collection changed since the packet

    failed = apply(BASE_URL, through(adapter), SNAPSHOT, answer_text(offered))

    assert failed != 0
    assert "packet" in capsys.readouterr().out
    assert {request.method for request in adapter.requests} == {"GET"}
    assert stored(editor_client, recipe.id)["status"] == "pending"


def test_an_answer_that_isnt_an_answer_is_rejected_before_anything_is_read(
    capsys: pytest.CaptureFixture[str],
) -> None:
    adapter = Adapter(lambda _: (500, {}, b""))

    failed = apply(BASE_URL, through(adapter), SNAPSHOT, '{"packet_id": "x", "density": 1}')

    assert failed != 0
    assert adapter.requests == []
    assert "density" in capsys.readouterr().out


def test_a_rejected_recipe_is_not_written_and_the_others_are(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    bad = add(api_store, "Garlic Tofu")
    good = add(api_store, "Chili Noodles")
    send = through(api(editor_client))
    offered = work_packet(send, capsys)
    answered = json.loads(answer_text(offered))
    for recipe in answered["recipes"]:
        if recipe["recipe_id"] == bad.id:
            recipe["lines"] = [oil_line(fdc_id=9999), oil_line(line_id="i3", quantity={"low": 7})]

    failed = apply(BASE_URL, send, SNAPSHOT, json.dumps(answered))

    assert failed == 1
    out = capsys.readouterr().out
    assert "i1: FDC food 9999 wasn't offered" in out
    assert "i3: 7 isn't a number in the line" in out
    assert stored(editor_client, bad.id) == bad.model_dump(mode="json")
    assert stored(editor_client, good.id)["status"] == "awaiting_review"


def test_a_recipe_the_answer_leaves_out_stays_pending(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    recipe = add(api_store, "Garlic Tofu")
    send = through(api(editor_client))
    offered = work_packet(send, capsys)
    answered: dict[str, Any] = {
        "packet_id": offered["packet_id"],
        "model": "a-model",
        "recipes": [],
    }

    assert apply(BASE_URL, send, SNAPSHOT, json.dumps(answered)) == 0
    assert stored(editor_client, recipe.id)["status"] == "pending"


def test_a_wording_an_editor_confirmed_is_used_and_not_learned_again(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    glimmer = CanonicalIngredient(
        id=new_ulid(),
        name="glimmer oil",
        family="oil",
        store_category_id="aisles",
        confirmed=True,
        version=1,
        schema_version=SCHEMA_VERSION,
    )
    confirmed = Wording(
        wording="glimmer oil", canonical_id=glimmer.id, confirmed=True, schema_version=1
    )
    api_store.enrich_recipe(add(api_store, "Ready Stew", status="ready"), [glimmer], [confirmed])
    recipe = add(api_store, "Garlic Tofu")
    send = through(api(editor_client))
    offered = work_packet(send, capsys)
    (oil, *_) = offered["recipes"][0]["lines"]
    assert [c["id"] for c in oil["canonical_candidates"]] == [glimmer.id]

    failed = apply(
        BASE_URL, send, SNAPSHOT, answer_text(offered, oil_line(canonical={"id": glimmer.id}))
    )

    assert failed == 0
    assert (
        stored(editor_client, recipe.id)["facts"]["ingredients"]["i1"]["match"]["canonical_id"]
        == glimmer.id
    )
    assert bundle(editor_client)["wordings"] == [confirmed.model_dump(mode="json")]


def test_a_bulk_import_recipe_goes_straight_to_ready(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    recipe = add(api_store, "Bulk Curry", channel="bulk_import")
    send = through(api(editor_client))

    apply(BASE_URL, send, SNAPSHOT, answer_text(work_packet(send, capsys)))

    assert stored(editor_client, recipe.id)["status"] == "ready"


def test_every_request_carries_the_service_token_and_writes_their_bodys_sha256(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    add(api_store, "Garlic Tofu")
    adapter = api(editor_client)
    offered = work_packet(through(adapter), capsys)

    apply(BASE_URL, through(adapter), SNAPSHOT, answer_text(offered))

    assert all(r.headers[SERVICE_TOKEN_HEADER] == SERVICE_TOKEN for r in adapter.requests)
    writes = [request for request in adapter.requests if request.method == "PUT"]
    assert len(writes) == 1
    body = writes[0].body
    assert isinstance(body, bytes)
    assert writes[0].headers["x-amz-content-sha256"] == hashlib.sha256(body).hexdigest()
    assert writes[0].headers["content-type"] == "application/json"


def test_a_recipe_that_fails_to_write_is_reported_and_the_run_goes_on(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    first = add(api_store, "Garlic Tofu")
    second = add(api_store, "Chili Noodles")
    send = through(api(editor_client))
    offered = work_packet(send, capsys)
    lines = [{**oil_line(), "canonical": {"new": {**NEW_GLIMMER["new"], "name": "glim"}}}]

    def enrich_first_meanwhile(method: str, url: str, body: bytes | None) -> tuple[int, Any]:
        # Someone else enriches the first recipe between the CLI's read and its write.
        if method == "PUT" and first.id in url:
            send("PUT", url, body)
        return send(method, url, body)

    failed = apply(BASE_URL, enrich_first_meanwhile, SNAPSHOT, answer_text(offered, *lines))

    assert failed == 1
    assert stored(editor_client, second.id)["status"] == "awaiting_review"
    out = capsys.readouterr().out
    assert "Garlic Tofu → failed: 409" in out
    assert "Chili Noodles → awaiting_review" in out


def test_a_collection_the_cli_cant_list_fails_and_writes_nothing() -> None:
    # The API lists the Collection to anyone, so the 403 is CloudFront's, as for a blocked IP.
    adapter = Adapter(lambda _: (403, {"content-type": "application/json"}, b'{"message": "no"}'))

    failed = packet("https://plateful.example", through(adapter), SNAPSHOT)

    assert failed != 0
    assert [request.url for request in adapter.requests] == [
        "https://plateful.example/api/collection"
    ]


@pytest.mark.parametrize(
    "text", ["", "   ", "x" * 300], ids=["empty", "whitespace", "300 characters"]
)
def test_a_line_the_parser_cant_read_leaves_its_recipe_and_the_next_still_enriched(
    editor_client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str], text: str
) -> None:
    odd = add(
        api_store,
        "Odd Line Stew",
        lines=[IngredientLine(id="i1", text=text), IngredientLine(id="i2", text="2 quill eggs")],
    )
    after = add(api_store, "Garlic Tofu")
    send = through(api(editor_client))
    offered = work_packet(send, capsys)
    answered: dict[str, Any] = {
        "packet_id": offered["packet_id"],
        "model": "a-model",
        "recipes": [{"recipe_id": r["recipe_id"], "lines": []} for r in offered["recipes"]],
    }

    failed = apply(BASE_URL, send, SNAPSHOT, json.dumps(answered))

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
    adapter = redirect_to("/api/collection?v=3")

    status, _ = through(adapter)("GET", "https://plateful.example/api/collection", None)

    assert status == 200
    assert [request.url for request in adapter.requests][-1] == (
        "https://plateful.example/api/collection?v=3"
    )
    assert adapter.requests[-1].headers[SERVICE_TOKEN_HEADER] == SERVICE_TOKEN


@pytest.mark.parametrize(
    "location",
    ["https://elsewhere.example/api/collection", "http://plateful.example/api/collection"],
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
    monkeypatch.delenv("PLATEFUL_SERVICE_TOKEN", raising=False)

    with pytest.raises(SystemExit, match="PLATEFUL_SERVICE_TOKEN"):
        main(["packet", "https://d111111abcdef8.cloudfront.net"])
