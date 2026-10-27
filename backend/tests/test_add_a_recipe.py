"""Add a recipe from a website: ingest a URL, save what it captured, and list the Queued Ingests."""

import hashlib
from typing import TYPE_CHECKING, Any

import boto3
import pytest
import requests
from conftest import EDITOR
from fake_web import FakeWeb, Redirect, Served, bomb, page, photo

from recipes import api
from recipes.auth import SERVICE_TOKEN_HEADER
from recipes.ingest import MAX_PHOTO_BYTES
from recipes.models import SCHEMA_VERSION, QueuedIngest, card_for
from recipes.seed import RECIPES
from recipes.store import DuplicateSource, Store

if TYPE_CHECKING:
    from collections.abc import Callable

    from fastapi.testclient import TestClient
    from httpx2 import Response

    from recipes.images import ImageStore
    from recipes.ingest import Fetcher

URL = "https://plateful.test/miso-soup"
KEY = "https://plateful.test/miso-soup"
ROBOTS = "https://plateful.test/robots.txt"
PHOTO = "https://plateful.test/photos/miso-soup.jpg"
# 2001 characters, though its key, without the tracking parameter, is short.
LONG_URL = f"{URL}?utm_source=" + "x" * (2001 - len(f"{URL}?utm_source="))


@pytest.fixture
def web() -> FakeWeb:
    return FakeWeb({URL: (200, page("json-ld-recipe.html"))})


@pytest.fixture
def fetcher(web: FakeWeb) -> Callable[[], Fetcher]:
    return web.fetcher


def ingest(editor_client: TestClient, url: str = URL) -> Response:
    return editor_client.post("/api/ingest", json={"url": url}, headers=EDITOR)


def save(editor_client: TestClient, captured: dict[str, Any], **editor_fields: object) -> Response:
    return editor_client.post("/api/recipes", json={**captured, **editor_fields}, headers=EDITOR)


def add_photo(editor_client: TestClient, url: str = PHOTO) -> Response:
    return editor_client.post("/api/images", json={"url": url}, headers=EDITOR)


def queued(editor_client: TestClient) -> list[dict[str, Any]]:
    response = editor_client.get("/api/queued-ingests", headers=EDITOR)
    assert response.status_code == 200
    return response.json()


def raw_items(table: str) -> str:
    """Every item in the table, as one string to search."""
    return str(boto3.client("dynamodb").scan(TableName=table)["Items"])


# Ingest


def test_ingesting_a_url_captures_its_original_and_stores_nothing(
    editor_client: TestClient, store: Store, web: FakeWeb
) -> None:
    before = store.collection_version()

    response = ingest(editor_client)

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["source"]["kind"] == "website"
    assert body["source"]["url"] == URL
    assert body["source"]["site_name"] == "Plateful Test Kitchen"
    assert body["source"]["captured_at"]
    assert body["original"]["title"] == "Weeknight Miso Soup"
    assert body["original"]["extractor"] == "recipe-scrapers"
    assert body["original"]["stated_times"]["total"] == {"text": "PT1H15M", "seconds": 4500}
    assert body["original"]["stated_times"]["cook"] == {"text": "about 20 minutes", "seconds": None}
    assert body["candidate_photos"] == [PHOTO, "https://plateful.test/photos/miso-soup-wide.jpg"]
    assert "candidate_photos" not in body["original"]
    assert web.urls == [ROBOTS, URL]
    assert store.source_guard(KEY) is None
    assert store.cards() == []
    assert store.queued_ingests() == []
    assert store.collection_version() == before


def test_a_page_without_its_own_site_name_is_named_for_its_host(
    editor_client: TestClient, web: FakeWeb
) -> None:
    url = "https://www.plateful.test/garlic-rice"
    web.pages[url] = (200, page("json-ld-graph.html"))

    response = ingest(editor_client, url)

    assert response.status_code == 200
    assert response.json()["source"]["site_name"] == "plateful.test"


def test_a_host_past_a_site_names_limit_is_cut_to_its_first_200_characters(
    editor_client: TestClient, web: FakeWeb
) -> None:
    host = ".".join(letter * 63 for letter in "abcd")
    url = f"https://{host}/garlic-rice"
    web.pages[url] = (200, page("json-ld-graph.html"))

    response = ingest(editor_client, url)

    assert response.status_code == 200
    assert response.json()["source"]["site_name"] == host[:200]


def test_a_page_whose_site_name_is_past_its_limit_is_named_by_its_first_200_characters(
    editor_client: TestClient, web: FakeWeb
) -> None:
    web.pages[URL] = (200, page("json-ld-recipe.html").replace("Plateful Test Kitchen", "x" * 300))

    response = ingest(editor_client)

    assert response.status_code == 200
    assert response.json()["source"]["site_name"] == "x" * 200


@pytest.mark.parametrize(
    "url",
    [
        "ftp://plateful.test/x",
        "plateful.test/x",
        "https://:443/x",
        "https://x.test:99999/",
        f"https://{'a' * 64}.test/x",
        pytest.param("https://plateful.test/" + "a" * 2000, id="a key past 2000 bytes"),
        pytest.param(LONG_URL, id="a url past 2000 characters with a short key"),
    ],
)
def test_an_invalid_url_is_refused(editor_client: TestClient, web: FakeWeb, url: str) -> None:
    response = ingest(editor_client, url)

    assert response.status_code == 422
    assert web.urls == []


def test_a_source_already_in_the_collection_is_a_duplicate_before_any_fetch(
    editor_client: TestClient, store: Store, web: FakeWeb
) -> None:
    recipe = store.add_recipe(RECIPES[0].model_copy(update={"dedupe_key": KEY}))

    response = ingest(
        editor_client, "HTTP://WWW.Plateful.test/miso-soup/?utm_source=newsletter#top"
    )

    assert response.status_code == 409
    assert response.json()["recipe_id"] == recipe.id
    assert response.json()["queued_ingest_id"] is None
    assert web.urls == [], "not even robots.txt is fetched"


def test_a_source_already_queued_is_a_duplicate_before_any_fetch(
    editor_client: TestClient, web: FakeWeb
) -> None:
    web.pages[URL] = (403, "Forbidden")
    first = ingest(editor_client).json()
    web.requests.clear()

    response = ingest(editor_client)

    assert response.status_code == 409
    assert response.json()["queued_ingest_id"] == first["id"]
    assert response.json()["recipe_id"] is None
    assert web.urls == []


def test_robots_txt_refusing_plateful_queues_the_source_for_its_page(
    editor_client: TestClient, store: Store, web: FakeWeb
) -> None:
    web.pages[ROBOTS] = (200, "User-agent: *\nDisallow: /\n")

    response = ingest(editor_client)

    assert response.status_code == 202
    body = response.json()
    assert (body["state"], body["reason"]) == ("needs_page", "robots")
    assert web.urls == [ROBOTS]
    guard = store.source_guard(KEY)
    assert guard is not None
    assert guard.queued_ingest_id == body["id"]
    assert guard.recipe_id is None


@pytest.mark.parametrize(
    ("served", "reason"),
    [
        ((403, "Forbidden"), "blocked"),
        ((429, "Slow down"), "rate_limited"),
        ((500, "Oops"), "server_error"),
        (requests.ReadTimeout(), "unreachable"),
        ((200, page("no-recipe.html")), "no_recipe"),
    ],
)
def test_a_failed_ingest_waits_for_the_fallback_with_its_source_reserved(
    editor_client: TestClient,
    store: Store,
    web: FakeWeb,
    served: tuple[int, str] | requests.RequestException,
    reason: str,
) -> None:
    tracked = f"{URL}?utm_campaign=x"
    web.pages[tracked] = served
    before = store.collection_version()

    response = ingest(editor_client, tracked)

    assert response.status_code == 202
    body = response.json()
    assert (body["state"], body["reason"]) == ("waiting", reason)
    assert body["dedupe_key"] == KEY
    assert body["source"]["url"] == tracked
    assert body["schema_version"] == SCHEMA_VERSION
    assert queued(editor_client) == [body]
    guard = store.source_guard(KEY)
    assert guard is not None
    assert guard.queued_ingest_id == body["id"]
    assert store.cards() == []
    assert store.collection_version() == before, "a Queued Ingest isn't in the Collection"


def test_a_url_off_the_public_internet_is_queued_for_its_page_without_a_request(
    editor_client: TestClient, web: FakeWeb
) -> None:
    response = ingest(editor_client, "http://127.0.0.1/")

    assert response.status_code == 202
    assert (response.json()["state"], response.json()["reason"]) == ("needs_page", "blocked")
    assert web.urls == []


def test_a_redirected_page_is_scraped_as_where_it_landed_and_kept_as_the_pasted_source(
    editor_client: TestClient, store: Store, web: FakeWeb, monkeypatch: pytest.MonkeyPatch
) -> None:
    short = "https://plateful.test/s/7"
    web.pages[short] = Redirect(URL)
    parsed_as: list[str] = []
    real_parse = api.parse

    def recording(html: str, url: str) -> Any:
        parsed_as.append(url)
        return real_parse(html, url)

    monkeypatch.setattr(api, "parse", recording)

    captured = ingest(editor_client, short).json()
    recipe = save(editor_client, captured).json()

    assert parsed_as == [URL]
    assert captured["source"]["url"] == short
    assert recipe["dedupe_key"] == short
    assert store.source_guard(KEY) is None


@pytest.mark.parametrize("guarded", [True, False])
def test_a_source_claimed_while_its_ingest_was_queued_is_a_duplicate_or_a_retry(
    editor_client: TestClient,
    api_store: Store,
    web: FakeWeb,
    monkeypatch: pytest.MonkeyPatch,
    *,
    guarded: bool,
) -> None:
    web.pages[URL] = (403, "Forbidden")
    recipe = RECIPES[0].model_copy(update={"dedupe_key": KEY})

    def raced(queued: QueuedIngest) -> None:
        if guarded:
            api_store.add_recipe(recipe)
        raise DuplicateSource(queued.dedupe_key)

    monkeypatch.setattr(api_store, "queue_ingest", raced)

    response = ingest(editor_client)

    assert response.status_code == 409
    expected = (
        {"detail": "Already in the Collection", "recipe_id": recipe.id, "queued_ingest_id": None}
        if guarded
        else {"detail": "Try again", "recipe_id": None, "queued_ingest_id": None}
    )
    assert response.json() == expected


def test_a_save_whose_guard_is_gone_again_is_a_retry(
    editor_client: TestClient, api_store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured = ingest(editor_client).json()

    def raced(recipe: Any) -> None:
        raise DuplicateSource(recipe.dedupe_key)

    monkeypatch.setattr(api_store, "add_recipe", raced)

    response = save(editor_client, captured)

    assert response.status_code == 409
    assert response.json() == {"detail": "Try again", "recipe_id": None, "queued_ingest_id": None}


@pytest.mark.parametrize("status", [404, 410])
def test_a_page_that_is_not_there_is_final_and_stores_nothing(
    editor_client: TestClient, store: Store, web: FakeWeb, status: int
) -> None:
    web.pages[URL] = (status, "")

    response = ingest(editor_client)

    assert response.status_code == 404
    assert store.source_guard(KEY) is None
    assert store.queued_ingests() == []


def test_a_queued_ingest_is_written_with_its_guard_in_one_transaction(
    editor_client: TestClient, api_store: Store, web: FakeWeb, monkeypatch: pytest.MonkeyPatch
) -> None:
    web.pages[URL] = (403, "Forbidden")
    transactions: list[list[dict[str, Any]]] = []
    write = api_store.client.transact_write_items

    def recording(**kwargs: Any) -> Any:
        transactions.append(kwargs["TransactItems"])
        return write(**kwargs)

    monkeypatch.setattr(api_store.client, "transact_write_items", recording)

    ingest(editor_client)

    assert len(transactions) == 1
    keys = sorted(item["Put"]["Item"]["PK"]["S"] for item in transactions[0])
    assert keys == ["INGEST", f"SOURCE#{KEY}"]


# Save


def test_saving_adds_the_recipe_pending_with_its_card_and_guard(
    editor_client: TestClient, store: Store
) -> None:
    captured = ingest(editor_client).json()
    before = store.collection_version()
    difficulty = {"prep": 1, "cook": 2, "cleanup": 1}

    response = save(editor_client, captured, difficulty=difficulty, tags=["Soup", "quick", "soup"])

    assert response.status_code == 201
    recipe = response.json()
    assert recipe["status"] == "pending"
    assert recipe["ingest_channel"] == "add_a_recipe"
    assert recipe["original"] == captured["original"]
    assert recipe["original"]["extractor"] == "recipe-scrapers"
    assert recipe["source"] == captured["source"]
    assert recipe["dedupe_key"] == KEY
    assert recipe["difficulty"] == difficulty
    assert recipe["tags"] == ["Soup", "quick"]
    assert recipe["version"] == 1
    assert (recipe["images"], recipe["preview"]) == ([], None)
    stored = store.get_recipe(recipe["id"])
    assert stored is not None
    assert stored.model_dump(mode="json") == recipe
    assert store.cards() == [card_for(stored)]
    guard = store.source_guard(KEY)
    assert guard is not None
    assert guard.recipe_id == recipe["id"]
    assert store.collection_version() == before + 1


def test_saving_keys_the_recipe_by_its_normalised_source(
    editor_client: TestClient, store: Store, web: FakeWeb
) -> None:
    tracked = "http://www.plateful.test/miso-soup?utm_source=x"
    web.pages[tracked] = (200, page("json-ld-recipe.html"))

    recipe = save(editor_client, ingest(editor_client, tracked).json()).json()

    assert recipe["source"]["url"] == tracked
    assert recipe["dedupe_key"] == KEY
    guard = store.source_guard(KEY)
    assert guard is not None
    assert guard.recipe_id == recipe["id"]


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("title", "x" * 301),
        ("author", "x" * 201),
        ("description", "x" * 5001),
        ("ingredients", [{"id": "i1", "text": "x" * 2001}]),
        ("steps", [{"id": f"s{n}", "text": "Stir."} for n in range(501)]),
        ("steps", [{"id": f"s{n}", "text": "x" * 2000} for n in range(200)]),
    ],
)
def test_an_original_past_its_limits_is_refused(
    editor_client: TestClient, store: Store, field: str, value: object
) -> None:
    captured = ingest(editor_client).json()

    response = save(editor_client, {**captured, "original": {**captured["original"], field: value}})

    assert response.status_code == 422
    assert store.cards() == []


def test_a_site_name_past_its_limit_is_refused(editor_client: TestClient, store: Store) -> None:
    captured = ingest(editor_client).json()

    response = save(
        editor_client, {**captured, "source": {**captured["source"], "site_name": "x" * 201}}
    )

    assert response.status_code == 422
    assert store.cards() == []


def test_a_source_url_past_2000_characters_is_refused(
    editor_client: TestClient, store: Store
) -> None:
    captured = ingest(editor_client).json()

    response = save(editor_client, {**captured, "source": {**captured["source"], "url": LONG_URL}})

    assert response.status_code == 422
    assert store.cards() == []


@pytest.mark.parametrize("tags", [["x" * 101], [f"tag {n}" for n in range(51)]])
def test_tags_past_their_limits_are_refused(editor_client: TestClient, tags: list[str]) -> None:
    response = save(editor_client, ingest(editor_client).json(), tags=tags)

    assert response.status_code == 422


def test_saving_a_source_twice_is_a_duplicate(editor_client: TestClient, store: Store) -> None:
    captured = ingest(editor_client).json()
    first = save(editor_client, captured).json()

    response = save(editor_client, captured)

    assert response.status_code == 409
    assert response.json()["recipe_id"] == first["id"]
    assert [card.id for card in store.cards()] == [first["id"]]


def test_saving_a_queued_source_is_a_duplicate(editor_client: TestClient, web: FakeWeb) -> None:
    captured = ingest(editor_client).json()
    other = "https://plateful.test/blocked"
    web.pages[other] = (403, "Forbidden")
    reserved = ingest(editor_client, other).json()

    response = save(editor_client, {**captured, "source": {**captured["source"], "url": other}})

    assert response.status_code == 409
    assert response.json()["queued_ingest_id"] == reserved["id"]


def test_no_page_html_or_json_ld_is_ever_stored(
    editor_client: TestClient, table: str, web: FakeWeb
) -> None:
    save(editor_client, ingest(editor_client).json())
    web.pages["https://plateful.test/about"] = (200, page("no-recipe.html"))
    ingest(editor_client, "https://plateful.test/about")

    stored = raw_items(table)

    for fragment in ("<html", "<script", "application/ld+json", "@context", "never stored"):
        assert fragment not in stored


# Photos


def stored_photo(images: ImageStore, colour: str = "tomato") -> dict[str, Any]:
    return images.put(photo(colour=colour), origin=PHOTO).model_dump(mode="json")


def test_a_candidate_photo_is_stored_and_described_for_the_review(
    editor_client: TestClient, images: ImageStore, web: FakeWeb
) -> None:
    data = photo(1200, 900)
    web.pages[PHOTO] = Served(200, data, "image/jpeg")

    response = add_photo(editor_client)

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    image = response.json()
    assert image == {
        "id": hashlib.sha256(data).hexdigest()[:32],
        "width": 1200,
        "height": 900,
        "origin": PHOTO,
    }
    assert images.exists(image["id"])
    assert web.urls == [ROBOTS, PHOTO]


@pytest.mark.parametrize(
    ("pages", "status"),
    [
        pytest.param({ROBOTS: (200, "User-agent: *\nDisallow: /photos/\n")}, 502, id="robots"),
        pytest.param({PHOTO: (404, "")}, 404, id="not there"),
        pytest.param({PHOTO: (403, "Forbidden")}, 502, id="blocked"),
        pytest.param({PHOTO: (500, "Oops")}, 502, id="server error"),
        pytest.param({PHOTO: requests.ReadTimeout()}, 502, id="unreachable"),
        pytest.param({PHOTO: (200, page("no-recipe.html"))}, 422, id="not an image"),
        pytest.param(
            {PHOTO: Served(200, b"x" * (MAX_PHOTO_BYTES + 1), "image/jpeg")}, 422, id="too large"
        ),
        pytest.param({PHOTO: Served(200, bomb(), "image/png")}, 422, id="decompression bomb"),
    ],
)
def test_a_candidate_photo_that_cannot_be_stored_is_unavailable(
    editor_client: TestClient,
    images: ImageStore,
    web: FakeWeb,
    pages: dict[str, Any],
    status: int,
) -> None:
    web.pages.update(pages)

    response = add_photo(editor_client)

    assert response.status_code == status
    assert isinstance(response.json()["detail"], str)
    assert not images.client.list_objects_v2(Bucket=images.bucket).get("Contents")


@pytest.mark.parametrize("url", ["http://127.0.0.1/photo.png", "http://[::1]/photo.png"])
def test_a_candidate_photo_off_the_public_internet_is_never_requested(
    editor_client: TestClient, web: FakeWeb, url: str
) -> None:
    response = add_photo(editor_client, url)

    assert response.status_code == 502
    assert web.urls == []


@pytest.mark.parametrize("url", ["ftp://plateful.test/photo.png", "photo.png", ""])
def test_a_candidate_photo_that_isnt_a_web_address_is_refused(
    editor_client: TestClient, web: FakeWeb, url: str
) -> None:
    response = add_photo(editor_client, url)

    assert response.status_code == 422
    assert web.urls == []


def test_saving_keeps_the_chosen_photos_and_preview_on_the_recipe_and_its_card(
    editor_client: TestClient, store: Store, images: ImageStore
) -> None:
    first, second = stored_photo(images), stored_photo(images, "teal")
    preview = {"image_id": second["id"], "focal_x": 0.25, "focal_y": 1}

    response = save(
        editor_client, ingest(editor_client).json(), images=[first, second], preview=preview
    )

    assert response.status_code == 201
    recipe = response.json()
    assert recipe["images"] == [first, second]
    assert recipe["preview"] == {"image_id": second["id"], "focal_x": 0.25, "focal_y": 1.0}
    stored = store.get_recipe(recipe["id"])
    assert stored is not None
    assert stored.model_dump(mode="json") == recipe
    [card] = store.cards()
    assert card.preview is not None
    assert card.preview.model_dump(mode="json") == recipe["preview"]


def test_saving_without_a_photo_keeps_none(editor_client: TestClient, store: Store) -> None:
    response = save(editor_client, ingest(editor_client).json(), images=[], preview=None)

    assert response.status_code == 201
    assert (response.json()["images"], response.json()["preview"]) == ([], None)
    [card] = store.cards()
    assert card.preview is None


def invalid_photos(image: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Editor fields with photos that aren't valid, by what's wrong, around a stored `image`."""
    other = "0" * 32  # a well-formed id, but not a stored image's

    def preview(image_id: str = image["id"], x: float = 0.5, y: float = 0.5) -> dict[str, Any]:
        return {"image_id": image_id, "focal_x": x, "focal_y": y}

    return {
        "a bad id": {"images": [{**image, "id": "../../etc/passwd"}]},
        "an upper-case id": {"images": [{**image, "id": image["id"].upper()}]},
        "no width": {"images": [{**image, "width": 0}]},
        "a bad origin": {"images": [{**image, "origin": "photo.png"}]},
        "the same image twice": {"images": [image, image]},
        "too many": {"images": [{**image, "id": f"{n:032x}"} for n in range(21)]},
        "focal x past 1": {"images": [image], "preview": preview(x=1.5)},
        "focal y below 0": {"images": [image], "preview": preview(y=-0.1)},
        "a preview of another image": {"images": [image], "preview": preview(other)},
        "a preview without its image": {"preview": preview()},
        "an image not stored": {"images": [image, {**image, "id": other}]},
    }


@pytest.mark.parametrize("case", list(invalid_photos({"id": ""})))
def test_photos_that_are_not_valid_are_refused(
    editor_client: TestClient, store: Store, images: ImageStore, case: str
) -> None:
    captured = ingest(editor_client).json()

    response = save(editor_client, captured, **invalid_photos(stored_photo(images))[case])

    assert response.status_code == 422
    assert store.cards() == []


# Editors only


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("POST", "/api/ingest", {"url": URL}),
        ("POST", "/api/recipes", {}),
        ("POST", "/api/images", {"url": PHOTO}),
        ("GET", "/api/queued-ingests", None),
    ],
)
def test_a_visitor_cannot_add_a_recipe(
    editor_client: TestClient, web: FakeWeb, method: str, path: str, body: object
) -> None:
    for headers in ({}, {SERVICE_TOKEN_HEADER: "wrong-token"}):
        response = editor_client.request(method, path, json=body, headers=headers)

        assert response.status_code == 403
    assert web.urls == []


def test_the_service_token_lists_the_queued_ingests_in_queue_order(
    editor_client: TestClient, store: Store
) -> None:
    for n in range(3):
        store.queue_ingest(
            QueuedIngest.model_validate(
                {
                    **QUEUED,
                    "id": f"01K7Q00000000000000000000{n}",
                    "dedupe_key": f"https://plateful.test/{n}",
                }
            )
        )

    listed = queued(editor_client)

    assert [item["id"] for item in listed] == [f"01K7Q00000000000000000000{n}" for n in range(3)]


QUEUED: dict[str, Any] = {
    "schema_version": SCHEMA_VERSION,
    "source": {
        "kind": "website",
        "url": "https://plateful.test/x",
        "site_name": "plateful.test",
        "captured_at": "2026-10-01T12:00:00Z",
    },
    "state": "waiting",
    "reason": "blocked",
    "queued_at": "2026-10-01T12:00:00Z",
}
