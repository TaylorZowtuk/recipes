"""An editor plans a week: places recipes on its days, re-amounts and removes the entries."""

from typing import TYPE_CHECKING, Any, Never

import pytest
from conftest import EDITOR

from recipes.seed import RECIPES
from recipes.store import VersionConflict, week_key

if TYPE_CHECKING:
    from collections.abc import Callable

    from botocore.exceptions import ClientError
    from fastapi.testclient import TestClient
    from httpx2 import Response

    from recipes.models import Recipe, WeekPlan
    from recipes.store import Store

MONDAY = "2026-11-02"
MISSING_ID = "01K7ZZZZZZZZZZZZZZZZZZZZZZ"
ROAST, NOODLES = RECIPES[0], RECIPES[1]


def place(recipe: Recipe, day: int = 0, **fields: object) -> dict[str, Any]:
    return {"op": "place", "day": day, "recipe_id": recipe.id, **fields}


def remove(entry_id: str) -> dict[str, Any]:
    return {"op": "remove", "entry_id": entry_id}


def scale(factor: object) -> dict[str, Any]:
    return {"kind": "scale", "factor": factor}


def set_amount(entry_id: str, factor: object) -> dict[str, Any]:
    return {"op": "set_amount", "entry_id": entry_id, "amount": scale(factor)}


def patch(
    editor_client: TestClient,
    *operations: dict[str, Any],
    version: object = 0,
    monday: str = MONDAY,
    headers: dict[str, str] = EDITOR,
) -> Response:
    body = {"version": version, "operations": operations}
    return editor_client.patch(f"/api/weeks/{monday}", json=body, headers=headers)


def planned(editor_client: TestClient, *operations: dict[str, Any]) -> dict[str, Any]:
    """The plan after placing `operations` in a week with no plan yet."""
    response = patch(editor_client, *operations)
    assert response.status_code == 200
    return response.json()


def stored_item(store: Store, monday: str = MONDAY) -> dict[str, Any] | None:
    response = store.client.get_item(
        TableName=store.table, Key=week_key(monday), ConsistentRead=True
    )
    return response.get("Item")


def read_as(plan: WeekPlan) -> Callable[[str], WeekPlan]:
    """A read that happened before another write won the race."""

    def week_plan(_monday: str) -> WeekPlan:
        return plan

    return week_plan


def fail(*_args: object, **_kwargs: object) -> Never:
    msg = "Nothing should write"
    raise AssertionError(msg)


# Reading


def test_a_week_with_no_plan_reads_as_empty_at_version_0_and_stays_unwritten(
    editor_client: TestClient, store: Store
) -> None:
    response = editor_client.get(f"/api/weeks/{MONDAY}", headers=EDITOR)

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "schema_version": 1,
        "week_start": MONDAY,
        "days": [[], [], [], [], [], [], []],
        "grocery_ticks": [],
        "version": 0,
    }
    assert stored_item(store) is None


@pytest.mark.parametrize(
    "not_a_monday",
    [
        "2026-11-03",  # a Tuesday
        "2026-11-08",  # a Sunday
        "2026-02-30",  # no such day
        "20261102",  # a Monday, in another spelling
        "2026-W45-1",
        "2026-11-02T00:00:00",
        "1793577600",
        "monday",
    ],
)
def test_a_path_that_isnt_a_real_monday_is_refused(
    editor_client: TestClient, not_a_monday: str
) -> None:
    read = editor_client.get(f"/api/weeks/{not_a_monday}", headers=EDITOR)
    write = patch(editor_client, place(ROAST), monday=not_a_monday)

    assert read.status_code == 422
    assert read.headers["cache-control"] == "no-store"
    assert write.status_code == 422


# Placing


def test_the_first_placement_creates_the_plan(editor_client: TestClient, store: Store) -> None:
    roast = store.add_recipe(ROAST)

    response = patch(editor_client, place(roast, 2))

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    plan = response.json()
    assert plan["version"] == 1
    assert plan["week_start"] == MONDAY
    assert plan["grocery_ticks"] == []
    assert [len(day) for day in plan["days"]] == [0, 0, 1, 0, 0, 0, 0]
    (entry,) = plan["days"][2]
    assert entry["recipe_id"] == roast.id
    assert entry["recipe_title"] == roast.original.title
    assert entry["amount"] == scale(1)
    assert editor_client.get(f"/api/weeks/{MONDAY}", headers=EDITOR).json() == plan


def test_a_new_plan_is_stored_without_grocery_ticks(
    editor_client: TestClient, store: Store
) -> None:
    roast = store.add_recipe(ROAST)

    patch(editor_client, place(roast))

    item = stored_item(store)
    assert item is not None
    assert item["PK"] == {"S": f"WEEK#{MONDAY}"}
    assert item["schema_version"] == {"N": "1"}
    assert item["version"] == {"N": "1"}
    assert "grocery_ticks" not in item
    assert "grocery_extras" not in item


def test_a_placement_can_give_its_amount(editor_client: TestClient, store: Store) -> None:
    roast = store.add_recipe(ROAST)

    plan = planned(editor_client, place(roast, amount=scale(1.5)))

    assert plan["days"][0][0]["amount"] == scale(1.5)


def test_the_title_comes_from_the_recipe_whatever_the_body_sends(
    editor_client: TestClient, store: Store
) -> None:
    roast = store.add_recipe(ROAST)

    plan = planned(editor_client, place(roast, recipe_title="Something else", entry_id=MISSING_ID))

    (entry,) = plan["days"][0]
    assert entry["recipe_title"] == roast.original.title
    assert entry["entry_id"] != MISSING_ID


def test_the_title_outlives_the_recipe(editor_client: TestClient, store: Store) -> None:
    roast = store.add_recipe(ROAST)
    planned(editor_client, place(roast))

    store.delete_recipe(roast)

    plan = editor_client.get(f"/api/weeks/{MONDAY}", headers=EDITOR).json()
    assert plan["days"][0][0]["recipe_title"] == roast.original.title


def test_entries_keep_their_order_and_a_recipe_can_appear_twice(
    editor_client: TestClient, store: Store
) -> None:
    roast, noodles = store.add_recipe(ROAST), store.add_recipe(NOODLES)

    first = planned(editor_client, place(roast, 1), place(noodles, 1))
    response = patch(editor_client, place(roast, 1), version=first["version"])

    day = response.json()["days"][1]
    assert [entry["recipe_id"] for entry in day] == [roast.id, noodles.id, roast.id]
    assert [entry["entry_id"] for entry in day[:2]] == [e["entry_id"] for e in first["days"][1]]
    assert len({entry["entry_id"] for entry in day}) == 3


def test_placing_a_recipe_that_doesnt_exist_writes_nothing(
    editor_client: TestClient, store: Store
) -> None:
    response = patch(editor_client, {"op": "place", "day": 0, "recipe_id": MISSING_ID})

    assert response.status_code == 404
    assert response.headers["cache-control"] == "no-store"
    assert stored_item(store) is None


# Removing and re-amounting


def test_removing_an_entry_keeps_the_others(editor_client: TestClient, store: Store) -> None:
    roast, noodles = store.add_recipe(ROAST), store.add_recipe(NOODLES)
    plan = planned(editor_client, place(roast, 3), place(noodles, 3))
    first, second = plan["days"][3]

    response = patch(editor_client, remove(first["entry_id"]), version=1)

    assert response.status_code == 200
    assert response.json()["days"][3] == [second]
    assert response.json()["version"] == 2


def test_removing_the_last_entry_keeps_the_plan_and_its_version(
    editor_client: TestClient, store: Store
) -> None:
    roast = store.add_recipe(ROAST)
    plan = planned(editor_client, place(roast))

    response = patch(editor_client, remove(plan["days"][0][0]["entry_id"]), version=1)

    assert response.json()["days"] == [[], [], [], [], [], [], []]
    assert response.json()["version"] == 2
    item = stored_item(store)
    assert item is not None
    assert item["version"] == {"N": "2"}
    assert editor_client.get(f"/api/weeks/{MONDAY}", headers=EDITOR).json()["version"] == 2


@pytest.mark.parametrize("factor", [0.5, 1, 1.5, 2, 3])
def test_an_entry_can_be_re_amounted_to_each_step(
    editor_client: TestClient, store: Store, factor: float
) -> None:
    roast = store.add_recipe(ROAST)
    (entry,) = planned(editor_client, place(roast))["days"][0]

    response = patch(editor_client, set_amount(entry["entry_id"], factor), version=1)

    assert response.status_code == 200
    assert response.json()["days"][0] == [{**entry, "amount": scale(factor)}]
    read = editor_client.get(f"/api/weeks/{MONDAY}", headers=EDITOR).json()
    assert read["days"][0][0]["amount"] == scale(factor)


def test_a_batch_of_operations_is_one_write(editor_client: TestClient, store: Store) -> None:
    roast, noodles = store.add_recipe(ROAST), store.add_recipe(NOODLES)
    plan = planned(editor_client, place(roast, 0), place(roast, 1))
    gone, kept = plan["days"][0][0]["entry_id"], plan["days"][1][0]["entry_id"]

    response = patch(editor_client, remove(gone), set_amount(kept, 2), place(noodles, 1), version=1)

    assert response.json()["version"] == 2
    assert response.json()["days"][0] == []
    assert [e["amount"]["factor"] for e in response.json()["days"][1]] == [2, 1]


@pytest.mark.parametrize("operation", [remove(MISSING_ID), set_amount(MISSING_ID, 2)])
def test_an_unknown_entry_is_404(
    editor_client: TestClient, store: Store, operation: dict[str, Any]
) -> None:
    roast = store.add_recipe(ROAST)
    planned(editor_client, place(roast))

    response = patch(editor_client, operation, version=1)

    assert response.status_code == 404
    assert response.headers["cache-control"] == "no-store"
    item = stored_item(store)
    assert item is not None
    assert item["version"] == {"N": "1"}


@pytest.mark.parametrize("operation", [remove(MISSING_ID), set_amount(MISSING_ID, 2)])
def test_only_a_placement_creates_a_plan(
    editor_client: TestClient, store: Store, operation: dict[str, Any]
) -> None:
    response = patch(editor_client, operation)

    assert response.status_code == 404
    assert stored_item(store) is None


# Versions


@pytest.mark.parametrize("stale", [0, 1, 3])
def test_a_stale_version_is_409(editor_client: TestClient, store: Store, stale: int) -> None:
    roast = store.add_recipe(ROAST)
    plan = planned(editor_client, place(roast))
    assert patch(editor_client, place(roast), version=1).json()["version"] == 2

    response = patch(editor_client, remove(plan["days"][0][0]["entry_id"]), version=stale)

    assert response.status_code == 409
    assert response.json() == {"detail": "Version conflict: reload and try again"}
    assert response.headers["cache-control"] == "no-store"
    item = stored_item(store)
    assert item is not None
    assert item["version"] == {"N": "2"}


def test_a_version_past_0_on_a_week_with_no_plan_is_409(
    editor_client: TestClient, store: Store
) -> None:
    roast = store.add_recipe(ROAST)

    response = patch(editor_client, place(roast), version=1)

    assert response.status_code == 409
    assert stored_item(store) is None


def test_a_racing_create_is_409(
    editor_client: TestClient, api_store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    roast = api_store.add_recipe(ROAST)
    before = api_store.week_plan(MONDAY)
    winner = planned(editor_client, place(roast))
    monkeypatch.setattr(api_store, "week_plan", read_as(before))

    response = patch(editor_client, place(roast))

    assert response.status_code == 409
    monkeypatch.undo()
    assert api_store.week_plan(MONDAY).model_dump(mode="json") == winner


def test_a_racing_write_is_409(
    editor_client: TestClient, api_store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    roast = api_store.add_recipe(ROAST)
    planned(editor_client, place(roast))
    before = api_store.week_plan(MONDAY)
    winner = patch(editor_client, place(roast), version=1).json()
    monkeypatch.setattr(api_store, "week_plan", read_as(before))

    response = patch(editor_client, place(roast), version=1)

    assert response.status_code == 409
    monkeypatch.undo()
    assert api_store.week_plan(MONDAY).model_dump(mode="json") == winner


def test_a_write_that_keeps_conflicting_is_a_version_conflict(
    store: Store, monkeypatch: pytest.MonkeyPatch, cancellation: Callable[..., ClientError]
) -> None:
    conflict = cancellation("TransactionConflict")

    def conflicting(**_kwargs: object) -> Never:
        raise conflict

    def no_wait(_seconds: float) -> None:
        pass

    monkeypatch.setattr(store.client, "transact_write_items", conflicting)
    monkeypatch.setattr(store, "sleep", no_wait)

    with pytest.raises(VersionConflict):
        store.save_week_plan(store.week_plan(MONDAY))


# What a plan write leaves alone


def test_a_plan_write_keeps_grocery_ticks_and_extras(
    editor_client: TestClient, store: Store
) -> None:
    roast = store.add_recipe(ROAST)
    plan = planned(editor_client, place(roast))
    store.client.update_item(
        TableName=store.table,
        Key=week_key(MONDAY),
        UpdateExpression="ADD grocery_ticks :ticks SET grocery_extras = :extras",
        ExpressionAttributeValues={
            ":ticks": {"SS": ["c:synthetic|1", "o:synthetic|2"]},
            ":extras": {"M": {"extra": {"M": {"text": {"S": "Paper towels"}}}}},
        },
    )

    placed = patch(editor_client, place(roast), version=1).json()
    amended = patch(editor_client, set_amount(plan["days"][0][0]["entry_id"], 2), version=2).json()
    removed = patch(editor_client, remove(plan["days"][0][0]["entry_id"]), version=3)

    assert sorted(placed["grocery_ticks"]) == ["c:synthetic|1", "o:synthetic|2"]
    assert sorted(amended["grocery_ticks"]) == ["c:synthetic|1", "o:synthetic|2"]
    assert sorted(removed.json()["grocery_ticks"]) == ["c:synthetic|1", "o:synthetic|2"]
    read = editor_client.get(f"/api/weeks/{MONDAY}", headers=EDITOR).json()
    assert sorted(read["grocery_ticks"]) == ["c:synthetic|1", "o:synthetic|2"]
    item = stored_item(store)
    assert item is not None
    assert set(item["grocery_ticks"]["SS"]) == {"c:synthetic|1", "o:synthetic|2"}
    assert item["grocery_extras"]["M"]["extra"]["M"]["text"] == {"S": "Paper towels"}


def test_plan_writes_never_bump_the_collection(editor_client: TestClient, store: Store) -> None:
    roast = store.add_recipe(ROAST)
    before = store.collection_version()

    plan = planned(editor_client, place(roast))
    entry_id = plan["days"][0][0]["entry_id"]
    patch(editor_client, set_amount(entry_id, 2), version=1)
    patch(editor_client, remove(entry_id), version=2)

    assert store.collection_version() == before


# What the API refuses


@pytest.mark.parametrize("factor", [0, 0.25, 0.75, 1.25, 2.5, 4, -1, "1", True, None])
def test_a_factor_off_the_steps_is_refused(
    editor_client: TestClient, store: Store, factor: object
) -> None:
    roast = store.add_recipe(ROAST)

    placing = patch(editor_client, place(roast, amount=scale(factor)))
    assert placing.status_code == 422
    assert stored_item(store) is None

    (entry,) = planned(editor_client, place(roast))["days"][0]
    assert patch(editor_client, set_amount(entry["entry_id"], factor), version=1).status_code == 422


@pytest.mark.parametrize(
    "body",
    [
        {"version": 0, "operations": []},
        {"operations": [{"op": "remove", "entry_id": MISSING_ID}]},
        {"version": -1, "operations": [{"op": "remove", "entry_id": MISSING_ID}]},
        {"version": 2**53 + 1, "operations": [{"op": "remove", "entry_id": MISSING_ID}]},
        {"version": 0, "operations": [{"op": "rename", "entry_id": MISSING_ID}]},
        {"version": 0, "operations": [{"op": "remove", "entry_id": "not-a-ulid"}]},
        {"version": 0, "operations": [{"op": "place", "day": 7, "recipe_id": MISSING_ID}]},
        {"version": 0, "operations": [{"op": "place", "day": -1, "recipe_id": MISSING_ID}]},
        {"version": 0, "operations": [{"op": "place", "recipe_id": MISSING_ID}]},
        {"version": 0, "operations": [{"op": "place", "day": 0, "recipe_id": "not-a-ulid"}]},
        {
            "version": 0,
            "operations": [
                {"op": "place", "day": 0, "recipe_id": MISSING_ID, "amount": {"factor": 1}}
            ],
        },
        {
            "version": 0,
            "operations": [
                {
                    "op": "place",
                    "day": 0,
                    "recipe_id": MISSING_ID,
                    "amount": {"kind": "batch", "quantity": 1, "unit": "cup"},
                }
            ],
        },
        {"version": 0, "operations": [{"op": "remove", "entry_id": MISSING_ID}] * 101},
    ],
)
def test_a_malformed_edit_is_refused(editor_client: TestClient, body: dict[str, Any]) -> None:
    response = editor_client.patch(f"/api/weeks/{MONDAY}", json=body, headers=EDITOR)

    assert response.status_code == 422
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("monday", [MONDAY, "2026-11-03"])
def test_visitors_are_refused_whatever_they_ask_for(
    editor_client: TestClient,
    api_store: Store,
    monkeypatch: pytest.MonkeyPatch,
    monday: str,
) -> None:
    monkeypatch.setattr(api_store.client, "transact_write_items", fail)

    read = editor_client.get(f"/api/weeks/{monday}")
    write = patch(editor_client, {"op": "nonsense"}, monday=monday, headers={})

    assert read.status_code == 403
    assert read.headers["cache-control"] == "no-store"
    assert write.status_code == 403
    assert write.headers["cache-control"] == "no-store"
