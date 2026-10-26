"""The enrich CLI parses each Pending recipe's lines and writes the facts through the API."""

import hashlib
from typing import TYPE_CHECKING, Any

import pytest
from fastapi.testclient import TestClient

from recipes.api import create_app
from recipes.auth import SERVICE_TOKEN_HEADER, Auth, AuthSettings, Claims, InvalidIdToken
from recipes.enrich import ENRICHMENT_VERSION, run
from recipes.models import (
    SCHEMA_VERSION,
    IngestChannel,
    IngredientLine,
    Original,
    Recipe,
    WebsiteSource,
    new_ulid,
)
from recipes.store import Store

if TYPE_CHECKING:
    from collections.abc import Iterator, Mapping

    from recipes.images import ImageStore

SERVICE_TOKEN = "synthetic-service-token"
SETTINGS = AuthSettings.parse(
    {"service-token-hash": hashlib.sha256(SERVICE_TOKEN.encode()).hexdigest()}
)
BASE_URL = "http://testserver"


def no_sign_in(token: str, audience: str) -> Claims:
    raise InvalidIdToken(token)


@pytest.fixture
def api_store(table: str) -> Store:
    return Store(table)


@pytest.fixture
def client(api_store: Store, images: ImageStore) -> Iterator[TestClient]:
    auth = Auth(settings=lambda: SETTINGS, verifier=no_sign_in)
    app = create_app(store=lambda: api_store, auth=lambda: auth, images=lambda: images)
    with TestClient(app) as client:
        yield client


class Sent:
    """Sends the CLI's requests to the in-process API, keeping each one."""

    def __init__(self, client: TestClient) -> None:
        self.client = client
        self.requests: list[tuple[str, str, dict[str, str], bytes | None]] = []

    def __call__(
        self, method: str, url: str, headers: Mapping[str, str], body: bytes | None
    ) -> tuple[int, Any]:
        self.requests.append((method, url, dict(headers), body))
        response = self.client.request(method, url, headers=headers, content=body)
        return response.status_code, response.json()


def add(
    store: Store,
    title: str,
    status: str = "pending",
    channel: IngestChannel | None = "add_a_recipe",
) -> Recipe:
    slug = title.lower().replace(" ", "-")
    lines = [
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
    return client.get(f"/api/recipes/{recipe_id}").json()


def test_a_pending_recipe_gets_a_parse_fact_for_every_line_across_its_components(
    client: TestClient, api_store: Store
) -> None:
    recipe = add(api_store, "Garlic Tofu")

    failed = run(BASE_URL, SERVICE_TOKEN, Sent(client))

    assert failed == 0
    enriched = stored(client, recipe.id)
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


def test_a_bulk_import_recipe_goes_straight_to_ready(client: TestClient, api_store: Store) -> None:
    recipe = add(api_store, "Bulk Curry", channel="bulk_import")

    run(BASE_URL, SERVICE_TOKEN, Sent(client))

    assert stored(client, recipe.id)["status"] == "ready"


def test_recipes_that_are_not_pending_are_left_alone(client: TestClient, api_store: Store) -> None:
    ready = add(api_store, "Ready Stew", status="ready")
    awaiting = add(api_store, "Awaiting Soup", status="awaiting_review")
    sent = Sent(client)

    failed = run(BASE_URL, SERVICE_TOKEN, sent)

    assert failed == 0
    assert stored(client, ready.id) == ready.model_dump(mode="json")
    assert stored(client, awaiting.id) == awaiting.model_dump(mode="json")
    assert not [r for r in sent.requests if r[0] != "GET"]


def test_every_request_carries_the_service_token_and_writes_their_bodys_sha256(
    client: TestClient, api_store: Store
) -> None:
    add(api_store, "Garlic Tofu")
    sent = Sent(client)

    run(BASE_URL, SERVICE_TOKEN, sent)

    assert all(headers[SERVICE_TOKEN_HEADER] == SERVICE_TOKEN for _, _, headers, _ in sent.requests)
    writes = [(headers, body) for method, _, headers, body in sent.requests if method == "PUT"]
    assert len(writes) == 1
    headers, body = writes[0]
    assert body is not None
    assert headers["x-amz-content-sha256"] == hashlib.sha256(body).hexdigest()


def test_a_recipe_that_fails_is_reported_and_the_run_goes_on(
    client: TestClient, api_store: Store, capsys: pytest.CaptureFixture[str]
) -> None:
    first = add(api_store, "Garlic Tofu")
    second = add(api_store, "Chili Noodles")
    sent = Sent(client)

    def enrich_first_meanwhile(
        method: str, url: str, headers: Mapping[str, str], body: bytes | None
    ) -> tuple[int, Any]:
        # Someone else enriches the first recipe between the CLI's read and its write.
        if method == "PUT" and first.id in url:
            sent("PUT", url, headers, body)
        return sent(method, url, headers, body)

    failed = run(BASE_URL, SERVICE_TOKEN, enrich_first_meanwhile)

    assert failed == 1
    assert stored(client, second.id)["status"] == "awaiting_review"
    out = capsys.readouterr().out
    assert "Garlic Tofu" in out
    assert "409" in out
    assert "Chili Noodles → awaiting_review" in out
