"""An editor edits a recipe's Tags, Difficulty and Preview Photo in one batch, or deletes it."""

from typing import TYPE_CHECKING, Any

import pytest
from conftest import EDITOR

from recipes.auth import SERVICE_TOKEN_HEADER
from recipes.models import Image, Preview, card_for
from recipes.seed import RECIPES
from recipes.store import source_key

if TYPE_CHECKING:
    from fastapi.testclient import TestClient
    from httpx2 import Response

    from recipes.models import Recipe
    from recipes.store import Store

MISSING_ID = "01K7ZZZZZZZZZZZZZZZZZZZZZZ"
ROAST, NOODLES = RECIPES[0], RECIPES[1]
FIRST = Image(id="a" * 32, width=800, height=600, origin="https://plateful.test/photos/a.jpg")
SECOND = Image(id="b" * 32, width=600, height=800, origin="https://plateful.test/photos/b.jpg")


def add(store: Store, recipe: Recipe = ROAST, **fields: object) -> Recipe:
    return store.add_recipe(recipe.model_copy(update=fields))


def edit(
    editor_client: TestClient,
    recipe: Recipe,
    *operations: dict[str, Any],
    version: int | None = None,
    headers: dict[str, str] = EDITOR,
) -> Response:
    body = {"version": recipe.version if version is None else version, "operations": operations}
    return editor_client.patch(f"/api/recipes/{recipe.id}", json=body, headers=headers)


def delete(
    editor_client: TestClient,
    recipe: Recipe,
    version: int | None = None,
    headers: dict[str, str] = EDITOR,
) -> Response:
    return editor_client.delete(
        f"/api/recipes/{recipe.id}",
        params={"version": recipe.version if version is None else version},
        headers=headers,
    )


def guard_item(store: Store, key: dict[str, Any]) -> object:
    return store.client.get_item(TableName=store.table, Key=key, ConsistentRead=True).get("Item")


def set_tags(*tags: str) -> dict[str, Any]:
    return {"op": "set_tags", "tags": list(tags)}


# Editing


def test_editing_applies_every_operation_in_one_write(
    editor_client: TestClient, store: Store
) -> None:
    added = add(store, images=[FIRST, SECOND], preview=None)
    before = store.collection_version()
    preview = {"image_id": SECOND.id, "focal_x": 0.25, "focal_y": 1.0}

    response = edit(
        editor_client,
        added,
        set_tags("Sunday", "family"),
        {"op": "set_difficulty", "difficulty": {"prep": 3, "cook": 2, "cleanup": 1}},
        {"op": "set_preview", "preview": preview},
    )

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    recipe = response.json()
    assert recipe["version"] == 2
    assert recipe["tags"] == ["Sunday", "family"]
    assert recipe["difficulty"] == {"prep": 3, "cook": 2, "cleanup": 1}
    assert recipe["preview"] == preview
    stored = store.get_recipe(added.id)
    assert stored is not None
    assert stored.model_dump(mode="json") == recipe
    assert store.cards() == [card_for(stored)]
    assert store.collection_version() == before + 1


def test_editing_leaves_what_no_operation_names(editor_client: TestClient, store: Store) -> None:
    added = add(store)

    recipe = edit(editor_client, added, set_tags("roast")).json()

    assert recipe["tags"] == ["roast"]
    assert recipe["difficulty"] == added.model_dump(mode="json")["difficulty"]
    assert recipe["original"] == added.model_dump(mode="json")["original"]


def test_difficulty_and_the_preview_photo_can_be_cleared(
    editor_client: TestClient, store: Store
) -> None:
    added = add(store, images=[FIRST], preview=Preview(image_id=FIRST.id, focal_x=0.5, focal_y=0.5))

    recipe = edit(
        editor_client,
        added,
        {"op": "set_difficulty", "difficulty": None},
        {"op": "set_preview", "preview": None},
    ).json()

    assert (recipe["difficulty"], recipe["preview"]) == (None, None)
    assert recipe["images"] == [FIRST.model_dump(mode="json")]
    [card] = store.cards()
    assert (card.difficulty, card.preview) == (None, None)


def test_set_tags_strips_them_drops_empty_ones_and_keeps_each_once(
    editor_client: TestClient, store: Store
) -> None:
    added = add(store, tags=[])

    recipe = edit(editor_client, added, set_tags(" Soup ", "", "quick", "SOUP", "  ")).json()

    assert recipe["tags"] == ["Soup", "quick"]


def test_tags_keep_the_spelling_another_recipe_already_uses(
    editor_client: TestClient, store: Store
) -> None:
    add(store, ROAST, tags=["Sunday", "roast"])
    noodles = add(store, NOODLES, tags=[])

    recipe = edit(editor_client, noodles, set_tags("SUNDAY", "Roast", "Quick")).json()

    assert recipe["tags"] == ["Sunday", "roast", "Quick"]


def test_a_recipe_can_respell_a_tag_no_other_recipe_uses(
    editor_client: TestClient, store: Store
) -> None:
    added = add(store, tags=["sunday"])

    recipe = edit(editor_client, added, set_tags("Sunday")).json()

    assert recipe["tags"] == ["Sunday"]


@pytest.mark.parametrize(
    "operations",
    [
        [],
        [set_tags("a"), set_tags("b")],
        [{"op": "set_difficulty", "difficulty": None}] * 2,
        [{"op": "rename", "title": "x"}],
        [{"op": "set_difficulty"}],
        [{"op": "set_difficulty", "difficulty": {"prep": 4, "cook": 1, "cleanup": 1}}],
        [set_tags(*(f"t{n}" for n in range(51)))],
        [set_tags("x" * 101)],
        [{"op": "set_preview", "preview": {"image_id": FIRST.id, "focal_x": 1.5, "focal_y": 0}}],
        [{"op": "set_preview", "preview": {"image_id": SECOND.id, "focal_x": 0, "focal_y": 0}}],
    ],
    ids=[
        "no operations",
        "set_tags twice",
        "set_difficulty twice",
        "an unknown op",
        "no difficulty",
        "a rating past 3",
        "51 tags",
        "a tag of 101 characters",
        "a focal point past 1",
        "a preview of an image the recipe doesn't have",
    ],
)
def test_an_edit_that_is_not_valid_is_refused_and_changes_nothing(
    editor_client: TestClient,
    store: Store,
    operations: list[dict[str, Any]],
) -> None:
    added = add(store, images=[FIRST])
    before = store.collection_version()

    response = edit(editor_client, added, *operations)

    assert response.status_code == 422
    assert store.get_recipe(added.id) == added
    assert store.collection_version() == before


def test_a_stale_edit_returns_409_and_changes_nothing(
    editor_client: TestClient, store: Store
) -> None:
    added = add(store)
    current = store.update_recipe(added.model_copy(update={"tags": ["newer"]}))
    before = store.collection_version()

    response = edit(editor_client, added, set_tags("stale"))

    assert response.status_code == 409
    assert response.json() == {"detail": "Version conflict: reload and try again"}
    assert response.headers["cache-control"] == "no-store"
    assert store.get_recipe(added.id) == current
    assert store.cards() == [card_for(current)]
    assert store.collection_version() == before


def test_editing_an_unknown_recipe_is_404(editor_client: TestClient, store: Store) -> None:
    missing = ROAST.model_copy(update={"id": MISSING_ID})

    assert edit(editor_client, missing, set_tags("x")).status_code == 404


# Deleting


def test_deleting_removes_the_recipe_its_card_and_its_source_guard(
    editor_client: TestClient, store: Store
) -> None:
    added = add(store)
    kept = add(store, NOODLES)
    before = store.collection_version()

    response = delete(editor_client, added)

    assert response.status_code == 204
    assert store.get_recipe(added.id) is None
    assert store.cards() == [card_for(kept)]
    assert store.source_guard(added.dedupe_key) is None
    assert store.source_guard(kept.dedupe_key) is not None
    assert store.collection_version() == before + 1


def test_a_stale_delete_returns_409_and_removes_nothing(
    editor_client: TestClient, store: Store
) -> None:
    added = add(store)
    current = store.update_recipe(added)
    before = store.collection_version()

    response = delete(editor_client, added)

    assert response.status_code == 409
    assert store.get_recipe(added.id) == current
    assert store.cards() == [card_for(current)]
    assert store.source_guard(added.dedupe_key) is not None
    assert store.collection_version() == before


@pytest.mark.parametrize("guard", ["names another recipe", "is missing"])
def test_a_delete_whose_source_guard_is_not_the_recipes_returns_409_and_removes_nothing(
    editor_client: TestClient, store: Store, guard: str
) -> None:
    added = add(store)
    key = source_key(added.dedupe_key)
    if guard == "is missing":
        store.client.delete_item(TableName=store.table, Key=key)
    else:
        store.client.put_item(
            TableName=store.table, Item={**key, "recipe_id": {"S": "01K7YYYYYYYYYYYYYYYYYYYYYY"}}
        )
    guard_before = guard_item(store, key)
    before = store.collection_version()

    response = delete(editor_client, added)

    assert response.status_code == 409
    assert store.get_recipe(added.id) == added
    assert store.cards() == [card_for(added)]
    assert guard_item(store, key) == guard_before
    assert store.collection_version() == before


@pytest.mark.parametrize("method", ["patch", "delete"])
def test_a_version_too_large_for_the_table_is_422(
    editor_client: TestClient, store: Store, method: str
) -> None:
    added = add(store)
    version = 10**40

    if method == "patch":
        response = edit(editor_client, added, set_tags("x"), version=version)
    else:
        response = delete(editor_client, added, version=version)

    assert response.status_code == 422
    assert store.get_recipe(added.id) == added


def test_deleting_an_unknown_recipe_is_404(editor_client: TestClient, store: Store) -> None:
    missing = ROAST.model_copy(update={"id": MISSING_ID})

    assert delete(editor_client, missing, version=1).status_code == 404


def test_a_delete_needs_the_version(editor_client: TestClient, store: Store) -> None:
    added = add(store)

    response = editor_client.delete(f"/api/recipes/{added.id}", headers=EDITOR)

    assert response.status_code == 422
    assert store.get_recipe(added.id) == added


# Editors only


def test_a_visitor_cannot_edit_or_delete_a_recipe(editor_client: TestClient, store: Store) -> None:
    added = add(store)
    for headers in ({}, {SERVICE_TOKEN_HEADER: "wrong-token"}):
        assert edit(editor_client, added, set_tags("x"), headers=headers).status_code == 403
        assert delete(editor_client, added, headers=headers).status_code == 403

    assert store.get_recipe(added.id) == added
