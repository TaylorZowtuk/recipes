"""Kitchen settings: an editor's batched Edit of the Store Categories, the Canonical Ingredients
a delete moves, and the Pantry Staple and Store Category of one Canonical Ingredient.
"""

import re
from collections import Counter
from typing import TYPE_CHECKING, Any

import pytest
from boto3.dynamodb.types import TypeSerializer
from conftest import EDITOR

from recipes.models import MAX_LABEL, SCHEMA_VERSION, CanonicalIngredient, StoreCategory
from recipes.store import COLLECTION_KEY, KITCHEN_KEY, MAX_TRANSACTION_ITEMS, canonical_key

if TYPE_CHECKING:
    from collections.abc import Callable

    from botocore.exceptions import ClientError
    from fastapi.testclient import TestClient
    from httpx2 import Response

    from recipes.models import KitchenSettings
    from recipes.store import Store

type Write = list[dict[str, Any]]

MOST_IN_ONE_WRITE = MAX_TRANSACTION_ITEMS - 2  # beside the Kitchen settings and META#collection
MISSING_ID = "01K7KTC0000000000000000ZZZ"
ULID = re.compile(r"[0-7][0-9A-HJKMNP-TV-Z]{25}")
SEED_IDS = ["household", "produce", "meat", "aisles", "spices", "dairy", "frozen", "bakery"]


def canonical(number: int, category: str, **fields: Any) -> CanonicalIngredient:
    return CanonicalIngredient(
        id=f"01K7KTC{number:019}",
        name=f"synthetic ingredient {number}",
        family="synthetic",
        store_category_id=category,
        version=1,
        schema_version=SCHEMA_VERSION,
        **fields,
    )


def seeded(store: Store, *ingredients: CanonicalIngredient) -> None:
    serialize = TypeSerializer().serialize
    for ingredient in ingredients:
        attributes = {k: serialize(v) for k, v in ingredient.model_dump().items()}
        store.client.put_item(
            TableName=store.table, Item={**canonical_key(ingredient.id), **attributes}
        )


def many(count: int, category: str) -> list[CanonicalIngredient]:
    return [canonical(number, category) for number in range(count)]


def edit(
    editor_client: TestClient,
    saved: KitchenSettings,
    *operations: dict[str, Any],
    headers: dict[str, str] = EDITOR,
) -> Response:
    body = {"version": saved.version, "operations": operations}
    return editor_client.patch("/api/kitchen-settings", json=body, headers=headers)


def edit_ingredient(
    editor_client: TestClient,
    ingredient: CanonicalIngredient,
    *operations: dict[str, Any],
    headers: dict[str, str] = EDITOR,
) -> Response:
    body = {"version": ingredient.version, "operations": operations}
    path = f"/api/canonical-ingredients/{ingredient.id}"
    return editor_client.patch(path, json=body, headers=headers)


def delete(category: str, move_to: str) -> dict[str, Any]:
    return {"op": "delete", "id": category, "move_to": move_to}


def ids(store: Store) -> list[str]:
    return [category.id for category in store.kitchen_settings().store_categories]


def names(store: Store) -> list[str]:
    return [category.name for category in store.kitchen_settings().store_categories]


def placed(store: Store) -> Counter[str]:
    """How many Canonical Ingredients each Store Category holds."""
    return Counter(item.store_category_id for item in store.canonical_ingredients())


def writes_kitchen(write: Write) -> bool:
    return any(item.get("Put", {}).get("Item", {}).get("PK") == KITCHEN_KEY["PK"] for item in write)


def checks_kitchen(write: Write) -> bool:
    return any(item.get("ConditionCheck", {}).get("Key") == KITCHEN_KEY for item in write)


def moves(write: Write) -> list[dict[str, Any]]:
    return [
        item["Update"]
        for item in write
        if item.get("Update", {}).get("Key", {}).get("PK") == {"S": "CANON"}
    ]


def bumps(write: Write) -> bool:
    return any(item.get("Update", {}).get("Key") == COLLECTION_KEY for item in write)


@pytest.fixture
def writes(api_store: Store, monkeypatch: pytest.MonkeyPatch) -> list[Write]:
    """Every transaction the API tries, in order."""
    transact = api_store.client.transact_write_items
    seen: list[Write] = []

    def watched(**kwargs: Any) -> Any:
        seen.append(kwargs["TransactItems"])
        return transact(**kwargs)

    monkeypatch.setattr(api_store.client, "transact_write_items", watched)
    return seen


def no_sleep(_seconds: float) -> None:
    pass


def before_write(
    api_store: Store, monkeypatch: pytest.MonkeyPatch, number: int, act: Callable[[], object]
) -> None:
    """Run `act` once, just before the API's `number`th transaction (counting from 1)."""
    transact = api_store.client.transact_write_items
    attempts = 0

    def interrupted(**kwargs: Any) -> Any:
        nonlocal attempts
        attempts += 1
        if attempts == number:
            act()
        return transact(**kwargs)

    monkeypatch.setattr(api_store.client, "transact_write_items", interrupted)


# Each operation


def test_the_seed_categories_can_be_renamed(editor_client: TestClient, store: Store) -> None:
    saved = store.kitchen_settings()

    response = edit(editor_client, saved, {"op": "rename", "id": "produce", "name": "  Fruit  "})

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["version"] == saved.version + 1
    assert ids(store) == SEED_IDS
    assert names(store)[1] == "Fruit"


def test_adding_a_category_appends_it_with_an_id_the_server_mints(
    editor_client: TestClient, store: Store
) -> None:
    response = edit(editor_client, store.kitchen_settings(), {"op": "add", "name": "Deli"})

    assert response.status_code == 200
    *seed, added = store.kitchen_settings().store_categories
    assert [category.id for category in seed] == SEED_IDS
    assert added.name == "Deli"
    assert ULID.fullmatch(added.id)


def test_reordering_the_categories(editor_client: TestClient, store: Store) -> None:
    order = list(reversed(SEED_IDS))

    response = edit(editor_client, store.kitchen_settings(), {"op": "reorder", "ids": order})

    assert response.status_code == 200
    assert ids(store) == order


def test_deleting_a_category_moves_its_ingredients_and_nothing_else_about_them(
    editor_client: TestClient, store: Store
) -> None:
    staple = canonical(1, "dairy", pantry_staple=True, confirmed=True, confirm_batch="batch")
    elsewhere = canonical(2, "produce")
    seeded(store, staple, elsewhere)

    response = edit(editor_client, store.kitchen_settings(), delete("dairy", "frozen"))

    assert response.status_code == 200
    assert "dairy" not in ids(store)
    assert store.canonical_ingredient(staple.id) == staple.model_copy(
        update={"store_category_id": "frozen", "version": 2}
    )
    assert store.canonical_ingredient(elsewhere.id) == elsewhere


def test_the_edit_answers_with_the_shape_the_bundle_uses(
    editor_client: TestClient, store: Store
) -> None:
    response = edit(editor_client, store.kitchen_settings(), {"op": "add", "name": "Deli"})

    bundle = editor_client.get("/api/collection", follow_redirects=True).json()
    assert response.json() == bundle["kitchen_settings"]


# Batches


def test_a_batch_applies_in_the_order_sent_in_one_write(
    editor_client: TestClient, store: Store, writes: list[Write]
) -> None:
    saved = store.kitchen_settings()
    version = store.collection_version()
    ingredient = canonical(1, "dairy")
    seeded(store, ingredient)

    response = edit(
        editor_client,
        saved,
        {"op": "rename", "id": "meat", "name": "First"},
        {"op": "rename", "id": "meat", "name": "Second"},
        delete("dairy", "frozen"),
        {"op": "reorder", "ids": [i for i in reversed(SEED_IDS) if i != "dairy"]},
        {"op": "add", "name": "Deli"},
    )

    assert response.status_code == 200
    assert names(store) == [
        "Bakery",
        "Frozen",
        "Spices",
        "Aisles",
        "Second",
        "Produce",
        "Household",
        "Deli",
    ]
    assert store.kitchen_settings().version == saved.version + 1
    assert store.collection_version() == version + 1
    [write] = writes
    assert writes_kitchen(write)
    assert len(moves(write)) == 1
    assert bumps(write)


def test_two_categories_can_swap_names_in_one_batch(
    editor_client: TestClient, store: Store
) -> None:
    response = edit(
        editor_client,
        store.kitchen_settings(),
        {"op": "rename", "id": "meat", "name": "Spare"},
        {"op": "rename", "id": "spices", "name": "Meat"},
        {"op": "rename", "id": "meat", "name": "Spices"},
    )

    assert response.status_code == 200
    assert names(store)[2] == "Spices"
    assert names(store)[4] == "Meat"


def test_a_name_freed_by_a_delete_can_be_used_in_the_same_batch(
    editor_client: TestClient, store: Store
) -> None:
    response = edit(
        editor_client,
        store.kitchen_settings(),
        delete("dairy", "frozen"),
        {"op": "add", "name": "dairy"},
    )

    assert response.status_code == 200
    assert names(store)[-1] == "dairy"


# Moving ingredients


def test_a_chain_of_deletes_sends_ingredients_to_the_end_of_it(
    editor_client: TestClient, store: Store
) -> None:
    seeded(store, canonical(1, "dairy"), canonical(2, "frozen"), canonical(3, "meat"))

    response = edit(
        editor_client,
        store.kitchen_settings(),
        delete("dairy", "frozen"),
        delete("frozen", "meat"),
    )

    assert response.status_code == 200
    assert placed(store) == {"meat": 3}
    assert all(item.version == 2 for item in store.canonical_ingredients() if item.id[-1] != "3")


def test_a_move_doesnt_conflict_with_a_staple_change_read_before_it(
    editor_client: TestClient,
    store: Store,
    api_store: Store,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ingredient = canonical(1, "dairy")
    seeded(store, ingredient)
    saved = store.kitchen_settings()

    def change_the_staple() -> None:
        seeded(store, ingredient.model_copy(update={"pantry_staple": True, "version": 2}))

    before_write(api_store, monkeypatch, 1, change_the_staple)

    response = edit(editor_client, saved, delete("dairy", "frozen"))

    assert response.status_code == 200
    moved = store.canonical_ingredient(ingredient.id)
    assert moved is not None
    assert (moved.store_category_id, moved.pantry_staple, moved.version) == ("frozen", True, 3)


def test_as_many_moves_as_fit_are_one_transaction(
    editor_client: TestClient, store: Store, writes: list[Write]
) -> None:
    seeded(store, *many(MOST_IN_ONE_WRITE, "dairy"))
    version = store.collection_version()

    response = edit(editor_client, store.kitchen_settings(), delete("dairy", "frozen"))

    assert response.status_code == 200
    assert placed(store) == {"frozen": MOST_IN_ONE_WRITE}
    assert store.collection_version() == version + 1
    [write] = writes
    assert len(write) == MAX_TRANSACTION_ITEMS


def test_more_moves_than_fit_go_in_chunks_with_the_kitchen_settings_last(
    editor_client: TestClient, store: Store, writes: list[Write]
) -> None:
    total = 2 * MOST_IN_ONE_WRITE + 1
    seeded(store, *many(total, "dairy"))
    saved = store.kitchen_settings()
    version = store.collection_version()

    response = edit(editor_client, saved, delete("dairy", "frozen"))

    assert response.status_code == 200
    assert placed(store) == {"frozen": total}
    assert "dairy" not in ids(store)
    *chunks, last = writes
    assert sum(len(moves(chunk)) for chunk in chunks) == total
    for chunk in chunks:
        assert len(chunk) <= MAX_TRANSACTION_ITEMS
        assert checks_kitchen(chunk)
        assert bumps(chunk)
        assert not writes_kitchen(chunk)
    assert writes_kitchen(last)
    assert store.kitchen_settings().version == saved.version + 1
    assert store.collection_version() == version + len(writes)


def test_a_failure_part_way_orphans_nothing_and_a_retry_finishes(
    editor_client: TestClient,
    store: Store,
    api_store: Store,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    total = MOST_IN_ONE_WRITE + 10
    seeded(store, *many(total, "dairy"))
    saved = store.kitchen_settings()
    bystander = canonical(total - 1, "dairy")

    def move_one_under_the_edit() -> None:
        seeded(store, bystander.model_copy(update={"store_category_id": "meat", "version": 2}))

    before_write(api_store, monkeypatch, 2, move_one_under_the_edit)

    response = edit(editor_client, saved, delete("dairy", "frozen"))

    assert response.status_code == 409
    assert store.kitchen_settings() == saved
    assert placed(store) == {"frozen": MOST_IN_ONE_WRITE, "dairy": 9, "meat": 1}

    retried = edit(editor_client, saved, delete("dairy", "frozen"))

    assert retried.status_code == 200
    assert "dairy" not in ids(store)
    assert placed(store) == {"frozen": total - 1, "meat": 1}


def test_a_chunk_stops_when_the_kitchen_settings_changed(
    editor_client: TestClient,
    store: Store,
    api_store: Store,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seeded(store, *many(MOST_IN_ONE_WRITE + 10, "dairy"))
    saved = store.kitchen_settings()

    def change_the_settings() -> None:
        store.save_kitchen_settings(saved)

    before_write(api_store, monkeypatch, 2, change_the_settings)

    response = edit(editor_client, saved, delete("dairy", "frozen"))

    assert response.status_code == 409
    assert "dairy" in ids(store)
    assert placed(store) == {"frozen": MOST_IN_ONE_WRITE, "dairy": 10}


def test_a_stale_edit_moves_nothing_even_past_the_limit(
    editor_client: TestClient, store: Store, api_store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    seeded(store, *many(MOST_IN_ONE_WRITE + 1, "dairy"))
    saved = store.kitchen_settings()
    before_write(api_store, monkeypatch, 1, lambda: store.save_kitchen_settings(saved))

    response = edit(editor_client, saved, delete("dairy", "frozen"))

    assert response.status_code == 409
    assert placed(store) == {"dairy": MOST_IN_ONE_WRITE + 1}


def test_an_ingredient_that_lands_in_the_category_during_the_chunks_still_moves(
    editor_client: TestClient,
    store: Store,
    api_store: Store,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    total = MOST_IN_ONE_WRITE + 10
    seeded(store, *many(total, "dairy"))
    late = canonical(total, "dairy")
    before_write(api_store, monkeypatch, 2, lambda: seeded(store, late))

    response = edit(editor_client, store.kitchen_settings(), delete("dairy", "frozen"))

    assert response.status_code == 200
    assert placed(store) == {"frozen": total + 1}


# Refused edits


def test_the_last_category_cant_be_deleted(editor_client: TestClient, store: Store) -> None:
    saved = store.save_kitchen_settings(
        store.kitchen_settings().model_copy(
            update={"store_categories": [StoreCategory(id="produce", name="Produce")]}
        )
    )

    response = edit(editor_client, saved, delete("produce", "produce"))

    assert response.status_code == 422
    assert "last" in response.json()["detail"]
    assert store.kitchen_settings() == saved


def test_the_last_category_is_checked_at_that_point_in_the_batch(
    editor_client: TestClient, store: Store
) -> None:
    categories = [StoreCategory(id=name.lower(), name=name) for name in ("Produce", "Meat")]
    saved = store.save_kitchen_settings(
        store.kitchen_settings().model_copy(update={"store_categories": categories})
    )

    response = edit(
        editor_client,
        saved,
        delete("produce", "meat"),
        delete("meat", "produce"),
        {"op": "add", "name": "Added too late"},
    )

    assert response.status_code == 422
    assert "last" in response.json()["detail"]
    assert store.kitchen_settings() == saved


REFUSED: list[list[dict[str, Any]]] = [
    [{"op": "rename", "id": "nowhere", "name": "Lost"}],
    [delete("nowhere", "produce")],
    [delete("dairy", "nowhere")],
    [delete("dairy", "dairy")],
    [delete("dairy", "frozen"), delete("frozen", "dairy")],
    [delete("dairy", "frozen"), {"op": "rename", "id": "dairy", "name": "Gone"}],
    [{"op": "reorder", "ids": SEED_IDS[:-1]}],
    [{"op": "reorder", "ids": [*SEED_IDS, "nowhere"]}],
    [{"op": "reorder", "ids": [*SEED_IDS[:-1], SEED_IDS[0]]}],
    [delete("dairy", "frozen"), {"op": "reorder", "ids": SEED_IDS}],
    [{"op": "add", "name": "   "}],
    [{"op": "add", "name": ""}],
    [{"op": "add", "name": "x" * (MAX_LABEL + 1)}],
    [{"op": "rename", "id": "dairy", "name": "  "}],
    [{"op": "rename", "id": "dairy", "name": "x" * (MAX_LABEL + 1)}],
    [{"op": "add", "name": "Produce"}],
    [{"op": "add", "name": "  pRODUCE "}],
    [{"op": "rename", "id": "dairy", "name": "PRODUCE"}],
    [{"op": "add", "name": "Deli"}, {"op": "add", "name": "deli"}],
    [{"op": "delete", "id": "dairy"}],
    [{"op": "unknown", "id": "dairy"}],
    [],
]


@pytest.mark.parametrize("operations", REFUSED)
def test_a_refused_edit_writes_nothing(
    editor_client: TestClient,
    store: Store,
    writes: list[Write],
    operations: list[dict[str, Any]],
) -> None:
    seeded(store, canonical(1, "dairy"))
    saved = store.kitchen_settings()
    version = store.collection_version()

    response = edit(editor_client, saved, *operations)

    assert response.status_code == 422
    assert store.kitchen_settings() == saved
    assert store.collection_version() == version
    assert placed(store) == {"dairy": 1}
    assert writes == []


def test_a_refused_edit_past_the_limit_moves_nothing(
    editor_client: TestClient, store: Store, writes: list[Write]
) -> None:
    seeded(store, *many(MOST_IN_ONE_WRITE + 1, "dairy"))

    response = edit(
        editor_client,
        store.kitchen_settings(),
        delete("dairy", "frozen"),
        {"op": "add", "name": "Frozen"},
    )

    assert response.status_code == 422
    assert writes == []


def test_a_visitor_cant_edit_the_kitchen_settings(editor_client: TestClient, store: Store) -> None:
    saved = store.kitchen_settings()

    response = edit(editor_client, saved, {"op": "add", "name": "Deli"}, headers={})

    assert response.status_code == 403
    assert store.kitchen_settings() == saved


# Conflicts


def test_a_stale_version_is_a_conflict_and_changes_nothing(
    editor_client: TestClient, store: Store, writes: list[Write]
) -> None:
    stale = store.kitchen_settings()
    saved = store.save_kitchen_settings(stale)
    version = store.collection_version()

    response = edit(editor_client, stale, {"op": "rename", "id": "nowhere", "name": "Stale"})

    assert response.status_code == 409
    assert store.kitchen_settings() == saved
    assert store.collection_version() == version
    assert writes == []


def test_a_write_racing_the_edit_is_a_conflict(
    editor_client: TestClient, store: Store, api_store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    saved = store.kitchen_settings()
    before_write(api_store, monkeypatch, 1, lambda: store.save_kitchen_settings(saved))

    response = edit(editor_client, saved, {"op": "add", "name": "Deli"})

    assert response.status_code == 409
    assert "Deli" not in names(store)


def test_an_ingredient_moved_under_a_one_transaction_delete_is_a_conflict(
    editor_client: TestClient, store: Store, api_store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    ingredient = canonical(1, "dairy")
    seeded(store, ingredient)
    saved = store.kitchen_settings()
    moved = ingredient.model_copy(update={"store_category_id": "meat", "version": 2})
    before_write(api_store, monkeypatch, 1, lambda: seeded(store, moved))

    response = edit(editor_client, saved, delete("dairy", "frozen"))

    assert response.status_code == 409
    assert store.kitchen_settings() == saved
    assert store.canonical_ingredient(ingredient.id) == moved


def test_a_chunk_that_keeps_conflicting_is_a_conflict(
    editor_client: TestClient,
    store: Store,
    api_store: Store,
    monkeypatch: pytest.MonkeyPatch,
    cancellation: Callable[..., ClientError],
) -> None:
    seeded(store, *many(MOST_IN_ONE_WRITE + 1, "dairy"))
    saved = store.kitchen_settings()

    def conflicts(**kwargs: Any) -> Any:
        raise cancellation(*["TransactionConflict"] * len(kwargs["TransactItems"]))

    monkeypatch.setattr(api_store.client, "transact_write_items", conflicts)
    monkeypatch.setattr(api_store, "sleep", no_sleep)

    response = edit(editor_client, saved, delete("dairy", "frozen"))

    assert response.status_code == 409
    assert store.kitchen_settings() == saved


# A Canonical Ingredient's Pantry Staple and Store Category


def test_setting_a_pantry_staple(
    editor_client: TestClient, store: Store, writes: list[Write]
) -> None:
    ingredient = canonical(1, "dairy", confirmed=True)
    seeded(store, ingredient)
    version = store.collection_version()

    response = edit_ingredient(
        editor_client, ingredient, {"op": "set_pantry_staple", "pantry_staple": True}
    )

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["version"] == 2
    assert store.canonical_ingredient(ingredient.id) == ingredient.model_copy(
        update={"pantry_staple": True, "version": 2}
    )
    assert store.collection_version() == version + 1
    [write] = writes
    assert not checks_kitchen(write)


def test_a_staple_change_doesnt_depend_on_the_kitchen_settings(
    editor_client: TestClient, store: Store, api_store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    ingredient = canonical(1, "dairy")
    seeded(store, ingredient)
    saved = store.kitchen_settings()
    before_write(api_store, monkeypatch, 1, lambda: store.save_kitchen_settings(saved))

    response = edit_ingredient(
        editor_client, ingredient, {"op": "set_pantry_staple", "pantry_staple": True}
    )

    assert response.status_code == 200


def test_setting_a_store_category(
    editor_client: TestClient, store: Store, writes: list[Write]
) -> None:
    ingredient = canonical(1, "dairy")
    seeded(store, ingredient)
    version = store.collection_version()

    response = edit_ingredient(
        editor_client, ingredient, {"op": "set_store_category", "store_category_id": "frozen"}
    )

    assert response.status_code == 200
    assert store.canonical_ingredient(ingredient.id) == ingredient.model_copy(
        update={"store_category_id": "frozen", "version": 2}
    )
    assert store.collection_version() == version + 1
    [write] = writes
    assert checks_kitchen(write)


def test_both_operations_are_one_write_applied_in_order(
    editor_client: TestClient, store: Store, writes: list[Write]
) -> None:
    ingredient = canonical(1, "dairy")
    seeded(store, ingredient)

    response = edit_ingredient(
        editor_client,
        ingredient,
        {"op": "set_pantry_staple", "pantry_staple": True},
        {"op": "set_store_category", "store_category_id": "meat"},
        {"op": "set_pantry_staple", "pantry_staple": False},
        {"op": "set_store_category", "store_category_id": "frozen"},
    )

    assert response.status_code == 200
    assert store.canonical_ingredient(ingredient.id) == ingredient.model_copy(
        update={"store_category_id": "frozen", "version": 2}
    )
    assert len(writes) == 1


def test_an_unknown_ingredient_is_not_found(editor_client: TestClient, store: Store) -> None:
    version = store.collection_version()

    response = edit_ingredient(
        editor_client,
        canonical(1, "dairy").model_copy(update={"id": MISSING_ID}),
        {"op": "set_pantry_staple", "pantry_staple": True},
    )

    assert response.status_code == 404
    assert store.collection_version() == version


@pytest.mark.parametrize(
    "operations",
    [
        [{"op": "set_store_category", "store_category_id": "nowhere"}],
        [
            {"op": "set_pantry_staple", "pantry_staple": True},
            {"op": "set_store_category", "store_category_id": "nowhere"},
        ],
        [{"op": "set_store_category", "store_category_id": ""}],
        [{"op": "set_pantry_staple", "pantry_staple": "maybe"}],
        [],
    ],
)
def test_a_refused_ingredient_edit_writes_nothing(
    editor_client: TestClient, store: Store, operations: list[dict[str, Any]]
) -> None:
    ingredient = canonical(1, "dairy")
    seeded(store, ingredient)
    version = store.collection_version()

    response = edit_ingredient(editor_client, ingredient, *operations)

    assert response.status_code == 422
    assert store.canonical_ingredient(ingredient.id) == ingredient
    assert store.collection_version() == version


def test_a_stale_ingredient_edit_is_a_conflict(editor_client: TestClient, store: Store) -> None:
    ingredient = canonical(1, "dairy")
    newer = ingredient.model_copy(update={"version": 2})
    seeded(store, newer)

    response = edit_ingredient(
        editor_client, ingredient, {"op": "set_pantry_staple", "pantry_staple": True}
    )

    assert response.status_code == 409
    assert store.canonical_ingredient(ingredient.id) == newer


def test_a_write_racing_the_ingredient_edit_is_a_conflict(
    editor_client: TestClient, store: Store, api_store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    ingredient = canonical(1, "dairy")
    seeded(store, ingredient)
    newer = ingredient.model_copy(update={"confirmed": True, "version": 2})
    before_write(api_store, monkeypatch, 1, lambda: seeded(store, newer))

    response = edit_ingredient(
        editor_client, ingredient, {"op": "set_pantry_staple", "pantry_staple": True}
    )

    assert response.status_code == 409
    assert store.canonical_ingredient(ingredient.id) == newer


def test_a_category_change_racing_the_kitchen_settings_is_a_conflict(
    editor_client: TestClient, store: Store, api_store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    ingredient = canonical(1, "dairy")
    seeded(store, ingredient)

    def delete_the_category() -> None:
        kept = [c for c in store.kitchen_settings().store_categories if c.id != "frozen"]
        settings = store.kitchen_settings().model_copy(update={"store_categories": kept})
        store.save_kitchen_settings(settings)

    before_write(api_store, monkeypatch, 1, delete_the_category)

    response = edit_ingredient(
        editor_client, ingredient, {"op": "set_store_category", "store_category_id": "frozen"}
    )

    assert response.status_code == 409
    assert store.canonical_ingredient(ingredient.id) == ingredient


def test_a_visitor_cant_edit_an_ingredient(editor_client: TestClient, store: Store) -> None:
    ingredient = canonical(1, "dairy")
    seeded(store, ingredient)

    response = edit_ingredient(
        editor_client, ingredient, {"op": "set_pantry_staple", "pantry_staple": True}, headers={}
    )

    assert response.status_code == 403
    assert store.canonical_ingredient(ingredient.id) == ingredient
