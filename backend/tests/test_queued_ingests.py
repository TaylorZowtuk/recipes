"""A Queued Ingest's way out: saved as a recipe, marked as needing its page, finished from a
pasted page, or discarded.
"""

import logging
from typing import TYPE_CHECKING, Any

import boto3
import pytest
from conftest import EDITOR
from fake_web import FakeWeb, Served, page

from recipes.auth import SERVICE_TOKEN_HEADER
from recipes.ingest import MAX_PAGE_BYTES, parse
from recipes.models import SCHEMA_VERSION, QueuedIngest
from recipes.store import source_key

if TYPE_CHECKING:
    from collections.abc import Callable

    from fastapi.testclient import TestClient
    from httpx2 import Response

    from recipes.ingest import Fetcher
    from recipes.store import Store

URL = "https://plateful.test/miso-soup"
INGEST_ID = "01K7Q000000000000000000001"
MISSING_ID = "01K7ZZZZZZZZZZZZZZZZZZZZZZ"
OTHER_INGEST_ID = "01K7Q000000000000000000002"
SOURCE = {
    "kind": "website",
    "url": URL,
    "site_name": "Plateful Test Kitchen",
    "captured_at": "2026-10-01T12:00:00Z",
}
# Text in the synthetic page that the recipe doesn't carry.
PAGE_ONLY_TEXT = "Page text that is never stored."


def queued_ingest(**fields: object) -> QueuedIngest:
    return QueuedIngest.model_validate(
        {
            "schema_version": SCHEMA_VERSION,
            "id": INGEST_ID,
            "source": SOURCE,
            "dedupe_key": URL,
            "state": "waiting",
            "reason": "blocked",
            "queued_at": "2026-10-01T12:00:00Z",
            **fields,
        }
    )


def new_recipe(**fields: object) -> dict[str, Any]:
    """A body as saving sends it: what a fallback captured, in the shape of `NewRecipe`."""
    original = parse(page("json-ld-recipe.html"), URL).original
    return {"source": SOURCE, "original": original.model_dump(mode="json"), **fields}


def save(editor_client: TestClient, body: dict[str, Any], ingest_id: str = INGEST_ID) -> Response:
    return editor_client.post(f"/api/queued-ingests/{ingest_id}/recipe", json=body, headers=EDITOR)


def needs_page(
    editor_client: TestClient, reason: str = "no_recipe", ingest_id: str = INGEST_ID
) -> Response:
    return editor_client.post(
        f"/api/queued-ingests/{ingest_id}/needs-page", json={"reason": reason}, headers=EDITOR
    )


def failed_attempt(
    editor_client: TestClient, reason: str = "rate_limited", ingest_id: str = INGEST_ID
) -> Response:
    return editor_client.post(
        f"/api/queued-ingests/{ingest_id}/failed-attempt", json={"reason": reason}, headers=EDITOR
    )


def paste(editor_client: TestClient, html: object, ingest_id: str = INGEST_ID) -> Response:
    return editor_client.post(
        f"/api/queued-ingests/{ingest_id}/pasted-page", json={"html": html}, headers=EDITOR
    )


def ingest(editor_client: TestClient) -> Response:
    return editor_client.post("/api/ingest", json={"url": URL}, headers=EDITOR)


def discard(editor_client: TestClient, ingest_id: str = INGEST_ID) -> Response:
    return editor_client.delete(f"/api/queued-ingests/{ingest_id}", headers=EDITOR)


def raw_items(table: str) -> str:
    """Every item in the table, as one string to search."""
    return str(boto3.client("dynamodb").scan(TableName=table)["Items"])


@pytest.fixture
def web() -> FakeWeb:
    return FakeWeb({})


@pytest.fixture
def fetcher(web: FakeWeb) -> Callable[[], Fetcher]:
    return web.fetcher


# Saving a Queued Ingest as a recipe


def test_saving_a_queued_ingest_turns_it_into_a_pending_recipe(
    editor_client: TestClient, store: Store
) -> None:
    store.queue_ingest(queued_ingest())
    before = store.collection_version()

    response = save(editor_client, new_recipe(tags=["Soup"]))

    assert response.status_code == 201
    recipe = response.json()
    assert recipe["status"] == "pending"
    assert recipe["ingest_channel"] == "add_a_recipe"
    assert recipe["version"] == 1
    assert recipe["dedupe_key"] == URL
    assert recipe["tags"] == ["Soup"]
    assert store.get_recipe(recipe["id"]) is not None
    assert [card.id for card in store.cards()] == [recipe["id"]]
    assert store.queued_ingests() == []
    guard = store.source_guard(URL)
    assert guard is not None
    assert (guard.recipe_id, guard.queued_ingest_id) == (recipe["id"], None)
    assert store.collection_version() == before + 1


def test_a_queued_ingest_becomes_a_recipe_in_one_transaction(
    editor_client: TestClient, api_store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    api_store.queue_ingest(queued_ingest())
    transactions: list[list[dict[str, Any]]] = []
    write = api_store.client.transact_write_items

    def recording(**kwargs: Any) -> Any:
        transactions.append(kwargs["TransactItems"])
        return write(**kwargs)

    monkeypatch.setattr(api_store.client, "transact_write_items", recording)

    recipe = save(editor_client, new_recipe()).json()

    assert len(transactions) == 1
    writes = [next(iter(item.values())) for item in transactions[0]]
    keys = sorted((write.get("Key") or write["Item"])["PK"]["S"] for write in writes)
    assert keys == ["CARD", "INGEST", "META#collection", f"RECIPE#{recipe['id']}", f"SOURCE#{URL}"]


def test_a_saved_queued_ingests_source_is_in_the_collection_until_its_recipe_is_deleted(
    editor_client: TestClient, store: Store, web: FakeWeb
) -> None:
    store.queue_ingest(queued_ingest())
    recipe = save(editor_client, new_recipe()).json()
    web.pages[URL] = (200, page("json-ld-recipe.html"))

    duplicate = editor_client.post("/api/ingest", json={"url": URL}, headers=EDITOR)

    assert duplicate.status_code == 409
    assert duplicate.json()["recipe_id"] == recipe["id"]
    assert web.urls == []

    deleted = editor_client.delete(f"/api/recipes/{recipe['id']}?version=1", headers=EDITOR)

    assert deleted.status_code == 204
    assert store.source_guard(URL) is None


def test_saving_an_unknown_queued_ingest_is_not_found(
    editor_client: TestClient, store: Store
) -> None:
    response = save(editor_client, new_recipe(), MISSING_ID)

    assert response.status_code == 404
    assert store.cards() == []


def test_a_source_that_normalises_to_the_queued_ingests_key_is_saved_as_sent(
    editor_client: TestClient, store: Store
) -> None:
    store.queue_ingest(queued_ingest())
    url = "https://www.plateful.test/miso-soup/?utm_source=mail"

    response = save(editor_client, new_recipe(source={**SOURCE, "url": url}))

    assert response.status_code == 201
    assert response.json()["source"]["url"] == url
    assert response.json()["dedupe_key"] == URL


@pytest.mark.parametrize(
    "url", ["https://plateful.test/another-soup", "https://:443/not-a-website"]
)
def test_a_source_that_isnt_the_queued_ingests_is_refused(
    editor_client: TestClient, store: Store, url: str
) -> None:
    store.queue_ingest(queued_ingest())

    response = save(editor_client, new_recipe(source={**SOURCE, "url": url}))

    assert response.status_code == 422
    assert store.cards() == []
    assert [item.id for item in store.queued_ingests()] == [INGEST_ID]


def test_a_photo_that_isnt_stored_is_refused(editor_client: TestClient, store: Store) -> None:
    store.queue_ingest(queued_ingest())
    image = {"id": "0" * 64, "width": 1, "height": 1, "origin": "https://plateful.test/p.jpg"}

    response = save(editor_client, new_recipe(images=[image]))

    assert response.status_code == 422
    assert [item.id for item in store.queued_ingests()] == [INGEST_ID]


def test_of_two_saves_racing_only_one_makes_a_recipe(
    editor_client: TestClient, api_store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    api_store.queue_ingest(queued_ingest())
    read = api_store.queued_ingest
    winners: list[Response] = []

    def the_other_save_lands_after_this_read(ingest_id: str) -> QueuedIngest | None:
        found = read(ingest_id)
        monkeypatch.setattr(api_store, "queued_ingest", read)
        winners.append(save(editor_client, new_recipe()))
        return found

    monkeypatch.setattr(api_store, "queued_ingest", the_other_save_lands_after_this_read)

    loser = save(editor_client, new_recipe())

    assert winners[0].status_code == 201
    assert loser.status_code == 409
    assert [card.id for card in api_store.cards()] == [winners[0].json()["id"]]
    guard = api_store.source_guard(URL)
    assert guard is not None
    assert guard.recipe_id == winners[0].json()["id"]


def test_saving_again_after_the_recipe_is_made_is_not_found(
    editor_client: TestClient, store: Store
) -> None:
    store.queue_ingest(queued_ingest())
    assert save(editor_client, new_recipe()).status_code == 201

    response = save(editor_client, new_recipe())

    assert response.status_code == 404
    assert len(store.cards()) == 1


def test_a_guard_that_no_longer_reserves_the_source_writes_nothing(
    editor_client: TestClient, store: Store
) -> None:
    store.queue_ingest(queued_ingest())
    store.client.update_item(
        TableName=store.table,
        Key=source_key(URL),
        UpdateExpression="SET queued_ingest_id = :other",
        ExpressionAttributeValues={":other": {"S": OTHER_INGEST_ID}},
    )

    response = save(editor_client, new_recipe())

    assert response.status_code == 409
    assert store.cards() == []
    assert store.queued_ingests() == [queued_ingest()]


def test_a_save_that_keeps_conflicting_is_a_conflict(
    store: Store,
    editor_client: TestClient,
    api_store: Store,
    monkeypatch: pytest.MonkeyPatch,
    cancellation: Callable[..., Exception],
) -> None:
    store.queue_ingest(queued_ingest())
    conflict = cancellation("TransactionConflict", "None", "None", "None", "None")

    def conflicting(**_kwargs: Any) -> None:
        raise conflict

    def no_wait(_seconds: float) -> None:
        pass

    monkeypatch.setattr(api_store, "sleep", no_wait)
    monkeypatch.setattr(api_store.client, "transact_write_items", conflicting)

    assert save(editor_client, new_recipe()).status_code == 409


# Marking a Queued Ingest as needing its page


def test_a_waiting_queued_ingest_is_marked_as_needing_its_page(
    editor_client: TestClient, store: Store
) -> None:
    store.queue_ingest(queued_ingest())
    before = store.collection_version()

    response = needs_page(editor_client, "no_recipe")

    assert response.status_code == 200
    assert response.json()["id"] == INGEST_ID
    assert response.json()["state"] == "needs_page"
    assert response.json()["reason"] == "no_recipe"
    assert store.queued_ingests() == [queued_ingest(state="needs_page", reason="no_recipe")]
    guard = store.source_guard(URL)
    assert guard is not None
    assert guard.queued_ingest_id == INGEST_ID
    assert store.collection_version() == before


def test_marking_a_queued_ingest_that_already_needs_its_page_changes_nothing(
    editor_client: TestClient, store: Store
) -> None:
    already = queued_ingest(state="needs_page", reason="robots")
    store.queue_ingest(already)

    response = needs_page(editor_client, "no_recipe")

    assert response.status_code == 200
    assert response.json()["state"] == "needs_page"
    assert response.json()["reason"] == "robots"
    assert store.queued_ingests() == [already]


def test_marking_an_unknown_queued_ingest_is_not_found(
    editor_client: TestClient, store: Store
) -> None:
    response = needs_page(editor_client, ingest_id=MISSING_ID)

    assert response.status_code == 404
    assert store.queued_ingests() == []


def test_a_reason_that_isnt_one_is_refused(editor_client: TestClient, store: Store) -> None:
    store.queue_ingest(queued_ingest())

    response = needs_page(editor_client, "tired")

    assert response.status_code == 422
    assert store.queued_ingests() == [queued_ingest()]


# Recording a fallback's failed attempt


def test_a_failed_attempt_on_a_waiting_queued_ingest_records_its_reason(
    editor_client: TestClient, store: Store
) -> None:
    store.queue_ingest(queued_ingest())
    before = store.collection_version()

    response = failed_attempt(editor_client, "rate_limited")

    assert response.status_code == 200
    assert response.json()["id"] == INGEST_ID
    assert response.json()["state"] == "waiting"
    assert response.json()["reason"] == "rate_limited"
    assert store.queued_ingests() == [queued_ingest(reason="rate_limited")]
    assert store.collection_version() == before


def test_a_failed_attempt_on_a_queued_ingest_that_needs_its_page_changes_nothing(
    editor_client: TestClient, store: Store
) -> None:
    already = queued_ingest(state="needs_page", reason="robots")
    store.queue_ingest(already)

    response = failed_attempt(editor_client, "server_error")

    assert response.status_code == 200
    assert response.json()["state"] == "needs_page"
    assert response.json()["reason"] == "robots"
    assert store.queued_ingests() == [already]


def test_a_failed_attempt_on_an_unknown_queued_ingest_is_not_found(
    editor_client: TestClient, store: Store
) -> None:
    response = failed_attempt(editor_client, ingest_id=MISSING_ID)

    assert response.status_code == 404
    assert store.queued_ingests() == []


@pytest.mark.parametrize("reason", ["robots", "blocked", "no_recipe", "tired"])
def test_a_failed_attempt_takes_only_a_reason_that_may_pass(
    editor_client: TestClient, store: Store, reason: str
) -> None:
    store.queue_ingest(queued_ingest())

    response = failed_attempt(editor_client, reason)

    assert response.status_code == 422
    assert store.queued_ingests() == [queued_ingest()]


# Parsing a pasted page


def test_a_pasted_page_is_captured_for_review_and_stores_nothing(
    editor_client: TestClient, store: Store, web: FakeWeb, table: str
) -> None:
    held = queued_ingest(state="needs_page", reason="robots")
    store.queue_ingest(held)
    before = raw_items(table)

    response = paste(editor_client, page("json-ld-recipe.html"))

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"source", "original", "candidate_photos"}
    assert body["source"]["kind"] == "website"
    assert body["source"]["url"] == URL
    assert body["source"]["site_name"] == "Plateful Test Kitchen"
    assert body["source"]["captured_at"]
    assert body["original"]["title"] == "Weeknight Miso Soup"
    assert body["original"]["extractor"] == "pasted-page"
    assert body["candidate_photos"] == [
        "https://plateful.test/photos/miso-soup.jpg",
        "https://plateful.test/photos/miso-soup-wide.jpg",
    ]
    assert PAGE_ONLY_TEXT not in response.text
    assert raw_items(table) == before
    assert web.urls == []


def test_a_pasted_page_without_its_own_site_name_is_named_for_its_host(
    editor_client: TestClient, store: Store
) -> None:
    store.queue_ingest(queued_ingest())

    response = paste(editor_client, page("json-ld-graph.html"))

    assert response.status_code == 200
    assert response.json()["source"]["site_name"] == "plateful.test"


def test_a_pasted_page_can_be_saved_as_the_queued_ingests_recipe(
    editor_client: TestClient, store: Store, table: str
) -> None:
    store.queue_ingest(queued_ingest())
    captured = paste(editor_client, page("json-ld-recipe.html")).json()
    del captured["candidate_photos"]

    response = save(editor_client, captured)

    assert response.status_code == 201
    assert response.json()["original"]["extractor"] == "pasted-page"
    assert PAGE_ONLY_TEXT not in raw_items(table)


def test_a_pasted_page_without_a_recipe_leaves_the_queued_ingest_as_it_is(
    editor_client: TestClient, store: Store
) -> None:
    store.queue_ingest(queued_ingest())
    html = page("no-recipe.html")

    response = paste(editor_client, html)

    assert response.status_code == 422
    assert html not in response.text
    assert store.queued_ingests() == [queued_ingest()]


def test_pasting_for_an_unknown_queued_ingest_is_not_found(editor_client: TestClient) -> None:
    assert paste(editor_client, page("json-ld-recipe.html"), MISSING_ID).status_code == 404


def test_a_pasted_page_at_the_limit_is_read(editor_client: TestClient, store: Store) -> None:
    store.queue_ingest(queued_ingest())
    html = page("json-ld-recipe.html")

    response = paste(editor_client, html + " " * (MAX_PAGE_BYTES - len(html.encode())))

    assert response.status_code == 200


@pytest.mark.parametrize("filler", ["x", "é"], ids=["one byte each", "two bytes each"])
def test_a_pasted_page_past_the_limit_is_refused_by_its_bytes(
    editor_client: TestClient, store: Store, filler: str
) -> None:
    store.queue_ingest(queued_ingest())
    html = page("json-ld-recipe.html")
    filling = MAX_PAGE_BYTES - len(html.encode()) + 2

    response = paste(editor_client, html + filler * (filling // len(filler.encode())))

    assert response.status_code == 413
    assert PAGE_ONLY_TEXT not in response.text
    assert store.queued_ingests() == [queued_ingest()]


@pytest.mark.parametrize("html", [[PAGE_ONLY_TEXT], {"page": PAGE_ONLY_TEXT}, 7])
def test_a_body_that_isnt_a_page_is_refused_without_echoing_it(
    editor_client: TestClient, store: Store, html: object
) -> None:
    store.queue_ingest(queued_ingest())

    response = paste(editor_client, html)

    assert response.status_code == 422
    assert PAGE_ONLY_TEXT not in response.text


def test_a_page_that_isnt_valid_unicode_is_refused(editor_client: TestClient, store: Store) -> None:
    store.queue_ingest(queued_ingest())

    response = editor_client.post(
        f"/api/queued-ingests/{INGEST_ID}/pasted-page",
        content=b'{"html": "\\ud800"}',
        headers={**EDITOR, "Content-Type": "application/json"},
    )

    assert response.status_code == 422


@pytest.mark.parametrize("fixture", ["json-ld-recipe.html", "no-recipe.html"])
def test_a_pasted_page_is_never_logged(
    editor_client: TestClient, store: Store, caplog: pytest.LogCaptureFixture, fixture: str
) -> None:
    store.queue_ingest(queued_ingest())
    html = page(fixture).replace("</body>", "<p>A sentence only the paste holds.</p></body>")

    with caplog.at_level(logging.DEBUG):
        paste(editor_client, html)

    assert "A sentence only the paste holds." not in caplog.text


def test_a_queued_spreadsheet_row_has_no_website_page_to_paste(
    editor_client: TestClient, store: Store
) -> None:
    row = {
        "kind": "spreadsheet",
        "url": URL,
        "sheet_id": "sheet",
        "entry_name": "soup",
        "captured_at": "2026-10-01T12:00:00Z",
    }
    store.queue_ingest(queued_ingest(source=row, dedupe_key="sheet/soup"))

    assert paste(editor_client, page("json-ld-recipe.html")).status_code == 422


# Discarding a Queued Ingest


@pytest.mark.parametrize("state", ["waiting", "needs_page"])
def test_discarding_a_queued_ingest_frees_its_source(
    editor_client: TestClient, store: Store, state: str
) -> None:
    store.queue_ingest(queued_ingest(state=state))
    version = store.collection_version()

    response = discard(editor_client)

    assert response.status_code == 204
    assert response.content == b""
    assert store.queued_ingests() == []
    assert store.source_guard(URL) is None
    assert store.collection_version() == version


def test_a_discarded_source_can_be_ingested_again(
    editor_client: TestClient, store: Store, web: FakeWeb
) -> None:
    web.pages[URL] = Served(403, "")
    assert ingest(editor_client).status_code == 202
    ingest_id = store.queued_ingests()[0].id
    assert ingest(editor_client).status_code == 409
    assert discard(editor_client, ingest_id).status_code == 204

    web.pages[URL] = Served(200, page("json-ld-recipe.html"))
    response = ingest(editor_client)

    assert response.status_code == 200
    assert response.json()["source"]["url"] == URL


def test_discarding_an_unknown_queued_ingest_is_not_found(
    editor_client: TestClient, store: Store
) -> None:
    store.queue_ingest(queued_ingest())

    assert discard(editor_client, MISSING_ID).status_code == 404

    assert store.queued_ingests() == [queued_ingest()]


def test_discarding_twice_is_not_found(editor_client: TestClient, store: Store) -> None:
    store.queue_ingest(queued_ingest())
    assert discard(editor_client).status_code == 204

    assert discard(editor_client).status_code == 404


def test_a_discard_that_lands_after_a_save_keeps_the_recipes_guard(
    editor_client: TestClient, api_store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    api_store.queue_ingest(queued_ingest())
    read = api_store.queued_ingest
    saves: list[Response] = []

    def the_save_lands_after_this_read(ingest_id: str) -> QueuedIngest | None:
        found = read(ingest_id)
        monkeypatch.setattr(api_store, "queued_ingest", read)
        saves.append(save(editor_client, new_recipe()))
        return found

    monkeypatch.setattr(api_store, "queued_ingest", the_save_lands_after_this_read)

    loser = discard(editor_client)

    assert saves[0].status_code == 201
    assert loser.status_code == 404
    assert [card.id for card in api_store.cards()] == [saves[0].json()["id"]]
    guard = api_store.source_guard(URL)
    assert guard is not None
    assert guard.recipe_id == saves[0].json()["id"]


def test_a_save_that_lands_after_a_discard_writes_nothing(
    editor_client: TestClient, api_store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    api_store.queue_ingest(queued_ingest())
    read = api_store.queued_ingest
    discards: list[Response] = []

    def the_discard_lands_after_this_read(ingest_id: str) -> QueuedIngest | None:
        found = read(ingest_id)
        monkeypatch.setattr(api_store, "queued_ingest", read)
        discards.append(discard(editor_client))
        return found

    monkeypatch.setattr(api_store, "queued_ingest", the_discard_lands_after_this_read)

    loser = save(editor_client, new_recipe())

    assert discards[0].status_code == 204
    assert loser.status_code == 409
    assert api_store.cards() == []
    assert api_store.source_guard(URL) is None


def test_a_guard_that_no_longer_points_at_the_queued_ingest_stops_the_discard(
    editor_client: TestClient, store: Store
) -> None:
    store.queue_ingest(queued_ingest())
    store.client.update_item(
        TableName=store.table,
        Key=source_key(URL),
        UpdateExpression="SET queued_ingest_id = :other",
        ExpressionAttributeValues={":other": {"S": OTHER_INGEST_ID}},
    )

    response = discard(editor_client)

    assert response.status_code == 409
    assert store.queued_ingests() == [queued_ingest()]
    guard = store.source_guard(URL)
    assert guard is not None
    assert guard.queued_ingest_id == OTHER_INGEST_ID


def test_a_discard_that_keeps_conflicting_is_a_conflict(
    store: Store,
    editor_client: TestClient,
    api_store: Store,
    monkeypatch: pytest.MonkeyPatch,
    cancellation: Callable[..., Exception],
) -> None:
    store.queue_ingest(queued_ingest())
    conflict = cancellation("TransactionConflict", "None")

    def conflicting(**_kwargs: Any) -> None:
        raise conflict

    def no_wait(_seconds: float) -> None:
        pass

    monkeypatch.setattr(api_store, "sleep", no_wait)
    monkeypatch.setattr(api_store.client, "transact_write_items", conflicting)

    assert discard(editor_client).status_code == 409


# Who can do it


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("recipe", new_recipe()),
        ("needs-page", {"reason": "no_recipe"}),
        ("failed-attempt", {"reason": "rate_limited"}),
        ("pasted-page", {"html": "<html></html>"}),
    ],
)
def test_a_visitor_cannot_finish_a_queued_ingest(
    editor_client: TestClient, store: Store, path: str, body: dict[str, Any]
) -> None:
    store.queue_ingest(queued_ingest())

    for headers in ({}, {SERVICE_TOKEN_HEADER: "wrong-token"}):
        response = editor_client.post(
            f"/api/queued-ingests/{INGEST_ID}/{path}", json=body, headers=headers
        )

        assert response.status_code == 403
    assert store.queued_ingests() == [queued_ingest()]
    assert store.cards() == []


def test_a_visitor_cannot_discard_a_queued_ingest(editor_client: TestClient, store: Store) -> None:
    store.queue_ingest(queued_ingest())

    for headers in ({}, {SERVICE_TOKEN_HEADER: "wrong-token"}):
        response = editor_client.delete(f"/api/queued-ingests/{INGEST_ID}", headers=headers)

        assert response.status_code == 403
    assert store.queued_ingests() == [queued_ingest()]
    assert store.source_guard(URL) is not None
