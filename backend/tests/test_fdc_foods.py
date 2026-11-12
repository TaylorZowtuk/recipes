"""An editor searches the FDC Snapshot for a line's food, and only the routes that need the
Snapshot load it.
"""

from typing import TYPE_CHECKING, Any, cast

import pytest
from conftest import EDITOR, SNAPSHOT
from test_enrichment_review import BEEF, CONFIRMED, awaiting
from test_review_edits import PORK, beef_line, edit, other

from recipes import fdc
from recipes.models import Per100g, Recipe

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
    body = response.json()
    assert body["default_fdc_id"] is None
    foods = body["foods"]
    assert [food["fdc_id"] for food in foods] == [
        food.fdc_id for food in SNAPSHOT.candidates("zorbleberries", 10)
    ]
    assert foods[0] == {
        "fdc_id": 1001,
        "dataset": "foundation",
        "description": "Zorbleberries, raw",
        "portions": [
            {
                "id": 501,
                "amount": 1.0,
                "unit": "cup",
                "modifier": None,
                "gram_weight": 144.0,
                **fdc.convert(SNAPSHOT.food(1001), 501).model_dump(exclude={"refused"}),
                "fits": None,
            },
            {
                "id": 502,
                "amount": 5.0,
                "unit": "berry",
                "modifier": None,
                "gram_weight": 10.0,
                "density_g_per_ml": None,
                "grams_per_count": 2.0,
                "count_unit": "berry",
                "fits": None,
            },
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
    assert len(response.json()["foods"]) == 10


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


def search(client: TestClient, **params: str | int) -> dict[str, Any]:
    response = client.get("/api/fdc/foods", params={"q": "zorbleberries", **params}, headers=EDITOR)
    assert response.status_code == 200, response.text
    return response.json()


def test_a_canonical_ingredients_default_food_is_a_confirmed_lines_in_another_recipe(
    editor_client: TestClient, api_store: Store
) -> None:
    other(api_store, 1, beef_line(fdc_id=2004))  # read first, but not Confirmed
    other(api_store, 2, beef_line("stewing beef", fdc_id=2007, **CONFIRMED))

    found = search(editor_client, canonical=BEEF.id)

    assert found["default_fdc_id"] == 2007
    ids = [food["fdc_id"] for food in found["foods"]]
    assert ids[0] == 2007
    assert ids[1:] == [food.fdc_id for food in SNAPSHOT.candidates("zorbleberries", 9)]


def test_an_unconfirmed_lines_food_is_the_default_when_no_line_is_confirmed(
    editor_client: TestClient, api_store: Store
) -> None:
    other(api_store, 1, beef_line(fdc_id=2004))

    assert search(editor_client, canonical=BEEF.id)["default_fdc_id"] == 2004


def test_a_canonical_ingredient_no_line_is_matched_to_has_no_default_food(
    editor_client: TestClient, api_store: Store
) -> None:
    other(api_store, 1, beef_line("stewing beef", fdc_id=2004, **CONFIRMED))

    found = search(editor_client, canonical=PORK.id)

    assert found["default_fdc_id"] is None
    assert [food["fdc_id"] for food in found["foods"]] == [
        food.fdc_id for food in SNAPSHOT.candidates("zorbleberries", 10)
    ]


def test_a_named_food_comes_first_so_the_picker_can_name_it(editor_client: TestClient) -> None:
    found = search(editor_client, fdc_id=2004)

    assert found["default_fdc_id"] is None
    assert found["foods"][0]["description"] == "Glimmer oil"
    assert search(editor_client, fdc_id=9999)["foods"] == search(editor_client)["foods"]


def test_a_search_reads_no_recipe_unless_asked_for_a_default(
    editor_client: TestClient, api_store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    loads: list[int] = []
    recipes = api_store.recipes

    def counted() -> list[Recipe]:
        loads.append(1)
        return recipes()

    monkeypatch.setattr(api_store, "recipes", counted)
    search(editor_client)
    assert loads == []
    search(editor_client, canonical=BEEF.id)
    assert loads == [1]


def fits(found: dict[str, Any], fdc_id: int) -> dict[int, bool | None]:
    """Whether each of the found food's portions fits the line's unit, by portion id."""
    food = next(food for food in found["foods"] if food["fdc_id"] == fdc_id)
    return {portion["id"]: portion["fits"] for portion in food["portions"]}


@pytest.mark.parametrize(
    ("fdc_id", "params", "expected"),
    [
        (2004, {"unit": "tbsp"}, {606: True, 607: True}),
        (2007, {"unit": "tbsp"}, {608: False, 609: False}),
        (2007, {"unit": "cloves"}, {608: True, 609: False}),
        (1002, {"unit": ""}, {503: True}),
        (2008, {"unit": ""}, {610: False}),
        (2007, {"unit": "g"}, {608: True, 609: True}),
        (2004, {"unit": "pinch"}, {606: False, 607: False}),
        (2004, {"unit": "pinch", "unit_kind": "volume"}, {606: True, 607: True}),
        (2004, {}, {606: None, 607: None}),
    ],
    ids=[
        "volume portion, tbsp line",
        "clove portion, tbsp line",
        "clove portion, cloves line",
        "each portion, line with no unit",
        "slice portion, line with no unit",
        "any portion, mass line",
        "volume portion, count line",
        "volume portion, unit the parser read as a volume",
        "no unit sent",
    ],
)
def test_each_portion_says_whether_it_fits_the_lines_unit_as_a_spread_pick_would(
    editor_client: TestClient, fdc_id: int, params: dict[str, str], expected: dict[int, bool | None]
) -> None:
    assert fits(search(editor_client, fdc_id=fdc_id, **params), fdc_id) == expected
