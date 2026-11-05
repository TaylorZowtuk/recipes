"""Favorite Sites: an editor's batched Edit, and the recipe counts the bundle derives from cards."""

from typing import TYPE_CHECKING, Any

import pytest
from conftest import EDITOR

from recipes import seed
from recipes.models import FavoriteSite, FavoriteSites, SpreadsheetSource, WebsiteSource
from recipes.seed import RECIPES
from recipes.store import FAVORITE_SITES_KEY, card_key

if TYPE_CHECKING:
    from fastapi.testclient import TestClient
    from httpx2 import Response

    from recipes.images import ImageStore
    from recipes.models import Recipe
    from recipes.store import Store

KITCHEN = FavoriteSite(
    id="01K7FAV0000000000000000001",
    name="Example Kitchen",
    address="https://example.com/",
    note="Weeknight dinners",
)
BAKERY = FavoriteSite(
    id="01K7FAV0000000000000000002", name="Example Bakery", address="https://example.org/", note=""
)
PANTRY = FavoriteSite(
    id="01K7FAV0000000000000000003", name="Example Pantry", address="https://example.net/", note=""
)
MISSING_ID = "01K7FAV00000000000000000ZZ"


def seeded(store: Store, *sites: FavoriteSite) -> FavoriteSites:
    return store.save_favorite_sites(
        store.favorite_sites().model_copy(update={"sites": list(sites)})
    )


def edit(
    editor_client: TestClient,
    saved: FavoriteSites,
    *operations: dict[str, Any],
    headers: dict[str, str] = EDITOR,
) -> Response:
    body = {"version": saved.version, "operations": operations}
    return editor_client.patch("/api/favorite-sites", json=body, headers=headers)


def add_site(name: str = "New Site", address: str = "https://example.edu/") -> dict[str, Any]:
    return {"op": "add", "name": name, "address": address}


def website_recipe(number: int, url: str, site_name: str = "Example Kitchen") -> Recipe:
    website = RECIPES[0].source
    assert isinstance(website, WebsiteSource)
    return RECIPES[0].model_copy(
        update={
            "id": f"01K7FAVREC00000000000000{number:02}",
            "source": website.model_copy(update={"url": url, "site_name": site_name}),
            "dedupe_key": url,
        }
    )


def bundle(client: TestClient) -> dict[str, Any]:
    return client.get("/api/collection", follow_redirects=True).json()


def counts(client: TestClient) -> dict[str, int]:
    sites = bundle(client)["favorite_sites"]["sites"]
    return {site["name"]: site["recipe_count"] for site in sites}


# Each operation


def test_renaming_a_site(editor_client: TestClient, store: Store) -> None:
    saved = seeded(store, KITCHEN)

    response = edit(editor_client, saved, {"op": "rename", "id": KITCHEN.id, "name": "  Home  "})

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["version"] == saved.version + 1
    assert store.favorite_sites().sites == [KITCHEN.model_copy(update={"name": "Home"})]


def test_setting_a_sites_address_keeps_it_as_written(
    editor_client: TestClient, store: Store
) -> None:
    saved = seeded(store, KITCHEN)
    address = "https://WWW.Example.edu/recipes"

    response = edit(
        editor_client, saved, {"op": "set_address", "id": KITCHEN.id, "address": address}
    )

    assert response.status_code == 200
    assert store.favorite_sites().sites[0].address == address


def test_setting_a_sites_note(editor_client: TestClient, store: Store) -> None:
    saved = seeded(store, KITCHEN)

    response = edit(editor_client, saved, {"op": "set_note", "id": KITCHEN.id, "note": ""})

    assert response.status_code == 200
    assert store.favorite_sites().sites[0].note == ""


def test_reordering_the_sites(editor_client: TestClient, store: Store) -> None:
    saved = seeded(store, KITCHEN, BAKERY, PANTRY)

    ids = [PANTRY.id, KITCHEN.id, BAKERY.id]

    response = edit(editor_client, saved, {"op": "reorder", "ids": ids})

    assert response.status_code == 200
    assert store.favorite_sites().sites == [PANTRY, KITCHEN, BAKERY]


def test_deleting_a_site(editor_client: TestClient, store: Store) -> None:
    saved = seeded(store, KITCHEN, BAKERY)

    response = edit(editor_client, saved, {"op": "delete", "id": KITCHEN.id})

    assert response.status_code == 200
    assert store.favorite_sites().sites == [BAKERY]


def test_adding_a_site_appends_it_with_an_id_the_server_mints(
    editor_client: TestClient, store: Store
) -> None:
    saved = seeded(store, KITCHEN)

    response = edit(
        editor_client,
        saved,
        {"op": "add", "name": "New", "address": "https://example.edu/", "note": "Soups"},
    )

    assert response.status_code == 200
    first, added = store.favorite_sites().sites
    assert first == KITCHEN
    assert (added.name, added.address, added.note) == ("New", "https://example.edu/", "Soups")
    assert added.id != KITCHEN.id


def test_a_site_can_be_added_without_a_note(editor_client: TestClient, store: Store) -> None:
    response = edit(editor_client, store.favorite_sites(), add_site())

    assert response.status_code == 200
    assert store.favorite_sites().sites[0].note == ""


def test_the_edit_answers_with_the_shape_the_bundle_uses(
    editor_client: TestClient, store: Store
) -> None:
    store.add_recipe(website_recipe(1, "https://example.com/soup"))
    saved = seeded(store, KITCHEN)

    response = edit(editor_client, saved, {"op": "rename", "id": KITCHEN.id, "name": "Home"})

    assert response.json() == {
        "version": saved.version + 1,
        "sites": [{**KITCHEN.model_dump(), "name": "Home", "recipe_count": 1}],
    }
    assert response.json() == bundle(editor_client)["favorite_sites"]


# Batches


def test_a_batch_applies_in_the_order_sent_in_one_write(
    editor_client: TestClient, store: Store, api_store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    saved = seeded(store, KITCHEN, BAKERY, PANTRY)
    version = store.collection_version()
    transact = api_store.client.transact_write_items
    writes: list[list[dict[str, Any]]] = []

    def counted(**kwargs: Any) -> Any:
        writes.append(kwargs["TransactItems"])
        return transact(**kwargs)

    monkeypatch.setattr(api_store.client, "transact_write_items", counted)

    response = edit(
        editor_client,
        saved,
        {"op": "rename", "id": KITCHEN.id, "name": "First"},
        {"op": "rename", "id": KITCHEN.id, "name": "Second"},
        {"op": "delete", "id": BAKERY.id},
        {"op": "reorder", "ids": [PANTRY.id, KITCHEN.id]},
        add_site(),
        {"op": "set_note", "id": PANTRY.id, "note": "Staples"},
        {"op": "set_note", "id": KITCHEN.id, "note": "Dinners"},
    )

    assert response.status_code == 200
    assert [(site.name, site.note) for site in store.favorite_sites().sites] == [
        ("Example Pantry", "Staples"),
        ("Second", "Dinners"),
        ("New Site", ""),
    ]
    assert store.favorite_sites().version == saved.version + 1
    assert store.collection_version() == version + 1
    [write] = writes
    assert write[0]["Put"]["Item"]["PK"] == FAVORITE_SITES_KEY["PK"]
    assert write[1]["Update"]["Key"]["PK"] == {"S": "META#collection"}


def test_a_reorder_covers_the_sites_present_at_that_point(
    editor_client: TestClient, store: Store
) -> None:
    saved = seeded(store, KITCHEN, BAKERY)

    response = edit(
        editor_client,
        saved,
        {"op": "delete", "id": KITCHEN.id},
        {"op": "reorder", "ids": [BAKERY.id, KITCHEN.id]},
    )

    assert response.status_code == 422
    assert store.favorite_sites() == saved


def test_two_sites_can_swap_addresses_in_one_batch(editor_client: TestClient, store: Store) -> None:
    saved = seeded(store, KITCHEN, BAKERY)

    response = edit(
        editor_client,
        saved,
        {"op": "set_address", "id": KITCHEN.id, "address": BAKERY.address},
        {"op": "set_address", "id": BAKERY.id, "address": KITCHEN.address},
    )

    assert response.status_code == 200
    assert [site.address for site in store.favorite_sites().sites] == [
        BAKERY.address,
        KITCHEN.address,
    ]


def test_a_batch_that_fails_validation_writes_nothing(
    editor_client: TestClient, store: Store
) -> None:
    saved = seeded(store, KITCHEN)
    version = store.collection_version()

    response = edit(
        editor_client,
        saved,
        {"op": "rename", "id": KITCHEN.id, "name": "Changed"},
        {"op": "delete", "id": MISSING_ID},
    )

    assert response.status_code == 422
    assert store.favorite_sites() == saved
    assert store.collection_version() == version


# Conflicts


def test_a_stale_version_is_a_conflict_and_changes_nothing(
    editor_client: TestClient, store: Store
) -> None:
    stale = seeded(store, KITCHEN)
    saved = seeded(store, KITCHEN, BAKERY)
    version = store.collection_version()

    response = edit(editor_client, stale, {"op": "rename", "id": KITCHEN.id, "name": "Stale"})

    assert response.status_code == 409
    assert store.favorite_sites() == saved
    assert store.collection_version() == version


def test_a_stale_batch_naming_a_deleted_site_is_a_conflict(
    editor_client: TestClient, store: Store
) -> None:
    stale = seeded(store, KITCHEN, BAKERY)
    saved = seeded(store, BAKERY)

    response = edit(editor_client, stale, {"op": "rename", "id": KITCHEN.id, "name": "Stale"})

    assert response.status_code == 409
    assert store.favorite_sites() == saved


def test_a_write_racing_the_edit_is_a_conflict(
    editor_client: TestClient, store: Store, api_store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    saved = seeded(store, KITCHEN)
    read = api_store.favorite_sites

    def read_then_lose_the_race() -> FavoriteSites:
        current = read()
        seeded(store, KITCHEN, BAKERY)
        return current

    monkeypatch.setattr(api_store, "favorite_sites", read_then_lose_the_race)

    response = edit(editor_client, saved, {"op": "rename", "id": KITCHEN.id, "name": "Raced"})

    assert response.status_code == 409


# Refused edits


@pytest.mark.parametrize(
    "address",
    [
        "https://example.org/",
        "http://www.EXAMPLE.org/recipes",
        "https://Example.org/desserts?page=2",
    ],
)
def test_two_sites_on_one_host_are_refused(
    editor_client: TestClient, store: Store, address: str
) -> None:
    saved = seeded(store, KITCHEN, BAKERY)

    added = edit(editor_client, saved, add_site(address=address))
    moved = edit(editor_client, saved, {"op": "set_address", "id": KITCHEN.id, "address": address})

    assert added.status_code == 422
    assert moved.status_code == 422
    assert store.favorite_sites() == saved


def test_a_subdomain_is_another_host(editor_client: TestClient, store: Store) -> None:
    saved = seeded(store, KITCHEN)

    response = edit(editor_client, saved, add_site(address="https://blog.example.com/"))

    assert response.status_code == 200


@pytest.mark.parametrize(
    "address",
    [
        "example.com",
        "ftp://example.com/",
        "https://",
        "https://exa mple.com/",
        "https://example.com:port/",
        "https://[x",
    ],
)
def test_an_invalid_address_is_refused(
    editor_client: TestClient, store: Store, address: str
) -> None:
    saved = seeded(store, KITCHEN)

    added = edit(editor_client, saved, add_site(address=address))
    moved = edit(editor_client, saved, {"op": "set_address", "id": KITCHEN.id, "address": address})

    assert added.status_code == 422
    assert moved.status_code == 422
    assert store.favorite_sites() == saved


@pytest.mark.parametrize("name", ["", "   ", "x" * 201])
def test_a_blank_or_overlong_name_is_refused(
    editor_client: TestClient, store: Store, name: str
) -> None:
    saved = seeded(store, KITCHEN)

    added = edit(editor_client, saved, add_site(name=name))
    renamed = edit(editor_client, saved, {"op": "rename", "id": KITCHEN.id, "name": name})

    assert added.status_code == 422
    assert renamed.status_code == 422
    assert store.favorite_sites() == saved


@pytest.mark.parametrize(
    "ids",
    [
        [],
        [KITCHEN.id],
        [KITCHEN.id, KITCHEN.id],
        [KITCHEN.id, BAKERY.id, MISSING_ID],
        [KITCHEN.id, MISSING_ID],
        [KITCHEN.id, BAKERY.id, BAKERY.id],
    ],
)
def test_a_reorder_that_is_no_permutation_is_refused(
    editor_client: TestClient, store: Store, ids: list[str]
) -> None:
    saved = seeded(store, KITCHEN, BAKERY)

    response = edit(editor_client, saved, {"op": "reorder", "ids": ids})

    assert response.status_code == 422
    assert store.favorite_sites() == saved


@pytest.mark.parametrize(
    "operation",
    [
        {"op": "rename", "id": MISSING_ID, "name": "Nowhere"},
        {"op": "set_address", "id": MISSING_ID, "address": "https://example.edu/"},
        {"op": "set_note", "id": MISSING_ID, "note": "Nowhere"},
        {"op": "delete", "id": MISSING_ID},
    ],
)
def test_an_unknown_site_is_refused(
    editor_client: TestClient, store: Store, operation: dict[str, Any]
) -> None:
    saved = seeded(store, KITCHEN)

    response = edit(editor_client, saved, operation)

    assert response.status_code == 422
    assert store.favorite_sites() == saved


def test_a_note_of_500_characters_is_the_longest_kept(
    editor_client: TestClient, store: Store
) -> None:
    saved = seeded(store, KITCHEN)

    longest = edit(editor_client, saved, {"op": "set_note", "id": KITCHEN.id, "note": "x" * 500})
    too_long = edit(
        editor_client,
        store.favorite_sites(),
        {"op": "set_note", "id": KITCHEN.id, "note": "x" * 501},
    )

    assert longest.status_code == 200
    assert too_long.status_code == 422


def sites(count: int) -> list[FavoriteSite]:
    return [
        FavoriteSite(
            id=f"01K7FAVS{number:018}",
            name=f"Site {number}",
            address=f"https://site{number}.example.com/",
            note="",
        )
        for number in range(count)
    ]


def test_the_list_holds_at_most_100_sites(editor_client: TestClient, store: Store) -> None:
    saved = seeded(store, *sites(99))

    hundredth = edit(editor_client, saved, add_site())
    full = store.favorite_sites()
    past_it = edit(editor_client, full, add_site(address="https://example.org/"))

    assert hundredth.status_code == 200
    assert past_it.status_code == 422
    assert store.favorite_sites() == full


def test_a_full_list_can_swap_a_site_in_one_batch(editor_client: TestClient, store: Store) -> None:
    full = sites(100)
    saved = seeded(store, *full)

    response = edit(editor_client, saved, add_site(), {"op": "delete", "id": full[0].id})

    stored = store.favorite_sites().sites
    assert response.status_code == 200
    assert len(stored) == 100
    assert "New Site" in [site.name for site in stored]


def test_an_empty_batch_is_refused(editor_client: TestClient, store: Store) -> None:
    assert edit(editor_client, store.favorite_sites()).status_code == 422


def test_a_visitor_cant_edit(client: TestClient, store: Store) -> None:
    saved = seeded(store, KITCHEN)

    response = edit(client, saved, {"op": "delete", "id": KITCHEN.id}, headers={})

    assert response.status_code == 403
    assert store.favorite_sites() == saved


# Counts in the bundle


def test_a_new_collections_bundle_has_no_sites(client: TestClient, store: Store) -> None:
    assert bundle(client)["favorite_sites"] == {"version": 1, "sites": []}


def test_the_bundle_serves_the_sites_in_list_order_to_a_visitor(
    client: TestClient, store: Store
) -> None:
    saved = seeded(store, BAKERY, KITCHEN)

    assert bundle(client)["favorite_sites"] == {
        "version": saved.version,
        "sites": [
            {**BAKERY.model_dump(), "recipe_count": 0},
            {**KITCHEN.model_dump(), "recipe_count": 0},
        ],
    }


@pytest.mark.parametrize(
    "address",
    [
        "https://example.com/",
        "https://www.example.com",
        "http://EXAMPLE.com/some/path",
        "https://WWW.Example.COM/recipes?page=2",
    ],
)
def test_a_site_counts_recipes_on_its_exact_host(
    client: TestClient, store: Store, address: str
) -> None:
    store.add_recipe(website_recipe(1, "https://example.com/soup"))
    store.add_recipe(website_recipe(2, "https://example.com/stew", site_name="Another Name"))
    store.add_recipe(website_recipe(3, "https://blog.example.com/salad"))
    store.add_recipe(website_recipe(4, "https://example.org/cake"))
    seeded(store, KITCHEN.model_copy(update={"address": address}))

    assert counts(client) == {"Example Kitchen": 2}


def test_a_site_on_a_subdomain_counts_only_that_subdomain(client: TestClient, store: Store) -> None:
    store.add_recipe(website_recipe(1, "https://example.com/soup"))
    store.add_recipe(website_recipe(2, "https://blog.example.com/salad"))
    seeded(store, KITCHEN.model_copy(update={"address": "https://blog.example.com/"}))

    assert counts(client) == {"Example Kitchen": 1}


def test_a_spreadsheet_recipe_counts_for_no_site(client: TestClient, store: Store) -> None:
    spreadsheet = next(r for r in RECIPES if isinstance(r.source, SpreadsheetSource))
    store.add_recipe(spreadsheet)
    seeded(store, KITCHEN)

    assert store.cards()[0].host is None
    assert counts(client) == {"Example Kitchen": 0}


def test_a_stored_card_without_a_host_loads_and_counts_for_no_site(
    client: TestClient, store: Store
) -> None:
    added = store.add_recipe(website_recipe(1, "https://example.com/soup"))
    store.client.update_item(
        TableName=store.table, Key=card_key(added.id), UpdateExpression="REMOVE host"
    )
    seeded(store, KITCHEN)

    assert store.cards()[0].host is None
    assert counts(client) == {"Example Kitchen": 0}


def test_the_next_write_gives_a_card_its_host(client: TestClient, store: Store) -> None:
    added = store.add_recipe(website_recipe(1, "https://example.com/soup"))
    store.client.update_item(
        TableName=store.table, Key=card_key(added.id), UpdateExpression="REMOVE host"
    )
    seeded(store, KITCHEN)

    store.update_recipe(added)

    assert counts(client) == {"Example Kitchen": 1}


def test_a_new_recipe_moves_the_bundle_to_a_new_count(client: TestClient, store: Store) -> None:
    seeded(store, KITCHEN)
    assert counts(client) == {"Example Kitchen": 0}

    store.add_recipe(website_recipe(1, "https://example.com/soup"))

    assert counts(client) == {"Example Kitchen": 1}


# The seed


def test_the_seed_has_a_site_counting_its_website_recipes(
    client: TestClient, store: Store, images: ImageStore
) -> None:
    seed.load(store, images)

    websites = [r for r in RECIPES if isinstance(r.source, WebsiteSource)]
    assert len(store.cards()) == len(RECIPES)
    assert counts(client)["Example Kitchen"] == len(websites)
