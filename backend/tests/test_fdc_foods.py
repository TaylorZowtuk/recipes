"""An editor searches the FDC Snapshot for a line's food, and only the routes that need the
Snapshot load it.
"""

from typing import TYPE_CHECKING, cast

import pytest
from conftest import EDITOR, SNAPSHOT
from test_enrichment_review import awaiting
from test_review_edits import edit

from recipes import fdc
from recipes.models import Per100g

if TYPE_CHECKING:
    from collections.abc import Callable

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from recipes.store import Store


def load_with(client: TestClient, snapshot: Callable[[], fdc.Snapshot]) -> None:
    """Have the started API load its FDC Snapshot with `snapshot`."""
    cast("FastAPI", client.app).state.snapshot = snapshot


def test_searching_gives_each_foods_portions_and_is_never_cached(
    editor_client: TestClient,
) -> None:
    response = editor_client.get("/api/fdc/foods", params={"q": "zorbleberries"}, headers=EDITOR)

    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    foods = response.json()
    assert [food["fdc_id"] for food in foods] == [
        food.fdc_id for food in SNAPSHOT.candidates("zorbleberries", 10)
    ]
    assert foods[0] == {
        "fdc_id": 1001,
        "dataset": "foundation",
        "description": "Zorbleberries, raw",
        "portions": [
            {"id": 501, "amount": 1.0, "unit": "cup", "modifier": None, "gram_weight": 144.0},
            {"id": 502, "amount": 5.0, "unit": "berry", "modifier": None, "gram_weight": 10.0},
        ],
    }


def test_searching_gives_at_most_ten_foods(editor_client: TestClient) -> None:
    nutrition = Per100g(kcal=None, protein_g=None, fat_g=None, carbs_g=None, sodium_mg=None)
    many = fdc.Snapshot(
        release="synthetic",
        foods=tuple(
            fdc.Food(
                fdc_id=n,
                dataset="sr_legacy",
                description=f"Zorble paste {n}",
                per_100g=nutrition,
                portions=(),
            )
            for n in range(1, 13)
        ),
    )
    load_with(editor_client, lambda: many)

    response = editor_client.get("/api/fdc/foods", params={"q": "zorble"}, headers=EDITOR)

    assert response.status_code == 200
    assert len(response.json()) == 10


@pytest.mark.parametrize("q", ["z", "z" * 61], ids=["too short", "too long"])
def test_searching_for_too_short_or_too_long_a_name_is_refused(
    editor_client: TestClient, q: str
) -> None:
    response = editor_client.get("/api/fdc/foods", params={"q": q}, headers=EDITOR)

    assert response.status_code == 422


def test_only_an_editor_can_search(client: TestClient) -> None:
    response = client.get("/api/fdc/foods", params={"q": "zorbleberries"})

    assert response.status_code == 403


def test_reads_and_other_edits_never_load_the_snapshot(
    editor_client: TestClient, api_store: Store
) -> None:
    loads: list[int] = []

    def counted() -> fdc.Snapshot:
        loads.append(1)
        return SNAPSHOT

    load_with(editor_client, counted)
    recipe = awaiting(api_store)

    assert editor_client.get("/api/sync", headers=EDITOR).status_code == 200
    assert editor_client.get(f"/api/recipes/{recipe.id}", headers=EDITOR).status_code in {200, 307}
    difficulty = edit(editor_client, recipe, kind="difficulty", prep=1, cook=2, cleanup=3)
    assert difficulty.status_code == 200
    assert loads == []
