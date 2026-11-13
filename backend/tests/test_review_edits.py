"""An editor edits a fact from its Review Item: a line, a step, a substitution or the Difficulty.
Each edit is saved Confirmed with provenance `editor`, and a line's new Canonical Ingredient fixes
its wording for every recipe in the Collection.
"""

from typing import TYPE_CHECKING, Any

import pytest
from conftest import EDITOR, SERVICE_TOKEN, SNAPSHOT
from test_enrichment_review import (
    BEEF,
    CONFIRMED,
    FACTS,
    STEW,
    SWAP,
    awaiting,
    card,
    conversion,
    fact,
    issue,
    match,
    parse,
    stored,
    uses,
)

from recipes import api, edits, fdc
from recipes.models import (
    MASS_UNITS,
    SCHEMA_VERSION,
    VOLUME_UNITS,
    CanonicalIngredient,
    Difficulty,
    DurationSegment,
    EnrichmentIssue,
    IngredientFacts,
    IngredientSegment,
    Recipe,
    RecipeFacts,
    SegmentsFact,
    StepFacts,
    SubstitutionsFact,
    TextSegment,
    Wording,
    unit_kind,
)
from recipes.parse import parse_line
from recipes.store import VersionConflict

if TYPE_CHECKING:
    from fastapi.testclient import TestClient
    from httpx2 import Response

    from recipes.store import Store

PORK = CanonicalIngredient(
    id="01K7Q0000000000000000000C2",
    name="pork shoulder",
    family="pork",
    store_category_id="meat",
    version=1,
    schema_version=SCHEMA_VERSION,
)
EDITED = {"provenance": "editor", "confirmed": True, "confirmed_by": "editor"}
DENSE = {"refused": None, "density_g_per_ml": 1.05}


def edit(client: TestClient, recipe: Recipe, version: int | None = None, **body: Any) -> Response:
    request = {"version": recipe.version if version is None else version, "edit": body}
    return client.post(f"/api/recipes/{recipe.id}/edit", json=request, headers=EDITOR)


def line_edit(line_id: str = "i1", **fields: Any) -> dict[str, Any]:
    return {
        "kind": "line",
        "line_id": line_id,
        "quantity": {"low": 900, "high": 900},
        "unit": "g",
        "name": "stewing beef",
        # As the stew's lines have it, so a food pick reaches the other recipes' lines.
        "preparation": None,
        # The beef line's food as enrichment matched it, so the food is unchanged.
        "fdc_id": 1001,
        "portion_id": None,
        **fields,
    }


def shared(response: Response) -> tuple[list[str], list[str], list[str]]:
    """The other recipes the edit matched, those that kept changing and those too big."""
    body = response.json()
    return body["also_updated"], body["not_updated"], body["too_big"]


def edited(found: dict[str, Any]) -> bool:
    return all(found[key] == value for key, value in EDITED.items()) and not found["confirm_batch"]


def other(
    store: Store,
    n: int,
    facts: RecipeFacts,
    issues: tuple[EnrichmentIssue, ...] = (),
    **fields: object,
) -> Recipe:
    """Another stew in the Collection, enriched without learning anything new."""
    return awaiting(
        store,
        facts=facts,
        issues=list(issues),
        canonicals=(),
        id=f"01K7Q0000000000000000000E{n}",
        dedupe_key=f"https://example.com/stew-{n}",
        **fields,
    )


def beef_line(name: str = "stewing beef", **match_fields: Any) -> RecipeFacts:
    return RecipeFacts(
        ingredients={
            "i1": IngredientFacts(
                parse=parse(name), match=match(**match_fields), conversion=conversion()
            )
        }
    )


# Lines


def test_editing_a_line_saves_it_confirmed_by_the_editor(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store)

    response = edit(
        editor_client,
        recipe,
        **line_edit(quantity={"low": 2, "high": 3}, unit="cup", preparation=None),
    )

    assert response.status_code == 200
    assert response.json()["recipe"]["version"] == recipe.version + 1
    saved = stored(api_store, recipe.id)
    parsed = fact(saved, "i1.parse")
    assert parsed["quantity"] == {"low": 2, "high": 3}
    assert (parsed["unit"], parsed["unit_kind"], parsed["preparation"]) == ("cup", "volume", None)
    assert edited(parsed)
    assert parsed["confidence"] == 1
    assert not parsed["estimated"]
    # The whole line is checked: its match and conversion are Confirmed, and its issue resolved.
    assert fact(saved, "i1.match")["confirmed"]
    assert fact(saved, "i1.conversion")["confirmed"]
    assert saved.issues[0].status == "resolved"
    assert card(api_store, recipe.id)["needs_review"]["unconfirmed"] == 3


@pytest.mark.parametrize(
    ("unit", "kind"),
    [
        ("g", "mass"),
        ("lb", "mass"),
        ("tbsp", "volume"),
        ("ml", "volume"),
        (None, "count"),
        ("cloves", "count"),
    ],
)
def test_a_lines_unit_kind_follows_its_unit(
    editor_client: TestClient, api_store: Store, unit: str | None, kind: str
) -> None:
    recipe = awaiting(api_store)

    assert edit(editor_client, recipe, **line_edit(unit=unit)).status_code == 200

    assert fact(stored(api_store, recipe.id), "i1.parse")["unit_kind"] == kind


@pytest.mark.parametrize(
    "line",
    [
        *("900 g beef", "2 tbsp flour", "1 cup barley", "8 fl oz stock", "2 lb pork"),
        *("1 l water", "3 tsp salt", "1 kg potatoes", "4 oz cheese", "1 quart milk"),
        *("3 cloves garlic", "2 eggs", "50 cl wine", "1 shot rum"),
    ],
)
def test_the_apis_unit_kinds_are_the_parsers(line: str) -> None:
    parsed = parse_line(line)

    assert unit_kind(parsed.unit) == parsed.unit_kind


@pytest.mark.parametrize("spelling", sorted(MASS_UNITS | VOLUME_UNITS))
def test_every_unit_the_api_knows_is_the_parsers_kind_where_the_parser_reads_it(
    spelling: str,
) -> None:
    parsed = parse_line(f"2 {spelling} flour")

    if parsed.unit is not None:  # the parser reads "mg" and "dl" as no unit at all
        assert unit_kind(spelling) == unit_kind(parsed.unit) == parsed.unit_kind


@pytest.mark.parametrize(("unit", "kind"), [("cl", "volume"), ("gill", "volume")])
def test_resaving_a_line_in_its_own_unit_keeps_the_units_kind(
    editor_client: TestClient, api_store: Store, unit: str, kind: str
) -> None:
    facts = beef_line()
    written = parse("stewing beef").model_copy(update={"unit": unit, "unit_kind": kind})
    facts.ingredients["i1"].parse = written
    recipe = awaiting(api_store, facts=facts)

    response = edit(editor_client, recipe, **line_edit(quantity={"low": 75, "high": 75}, unit=unit))

    assert response.status_code == 200
    assert fact(stored(api_store, recipe.id), "i1.parse")["unit_kind"] == kind


def test_editing_a_line_without_a_parse_reads_it(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store)

    carrots = {"kind": "new", "name": "Carrots", "family": "carrot", "store_category_id": "produce"}

    response = edit(
        editor_client, recipe, **line_edit("i5", name="carrots", unit=None, canonical=carrots)
    )

    assert response.status_code == 200
    assert fact(stored(api_store, recipe.id), "i5.parse")["name"] == "carrots"


def test_picking_a_food_for_a_line_with_no_canonical_ingredient_is_refused(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store)

    response = edit(editor_client, recipe, **line_edit("i5", name="carrots", unit=None))

    assert response.status_code == 422
    assert "i5" in response.json()["detail"]
    assert stored(api_store, recipe.id) == recipe


def test_a_line_with_no_canonical_ingredient_saves_without_an_fdc_food(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store)

    response = edit(
        editor_client, recipe, **line_edit("i9", name="parsley", unit=None, fdc_id=None)
    )

    assert response.status_code == 200
    line = stored(api_store, recipe.id).facts.ingredients["i9"]
    assert line.parse is not None
    assert line.parse.name == "parsley"
    assert (line.match, line.conversion) == (None, None)


@pytest.mark.parametrize(
    "canonical",
    [None, {"kind": "new", "name": "Beef", "family": "beef", "store_category_id": "meat"}],
    ids=["has one", "gets one"],
)
def test_a_line_with_a_canonical_ingredient_needs_an_fdc_food_naming_the_line(
    editor_client: TestClient, api_store: Store, canonical: dict[str, str] | None
) -> None:
    recipe = awaiting(api_store)

    response = edit(editor_client, recipe, **line_edit(fdc_id=None, canonical=canonical))

    assert response.status_code == 422
    assert "i1" in response.json()["detail"]
    assert stored(api_store, recipe.id) == recipe


def test_editing_a_line_the_recipe_lacks_is_refused(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store)

    response = edit(editor_client, recipe, **line_edit("i99"))

    assert response.status_code == 422
    assert stored(api_store, recipe.id) == recipe


def test_keeping_a_lines_weight_refuses_its_conversion_and_converting_clears_it(
    editor_client: TestClient, api_store: Store
) -> None:
    facts = beef_line()
    facts.ingredients["i1"].conversion = conversion(**DENSE)
    recipe = awaiting(api_store, facts=facts)

    kept = edit(editor_client, recipe, **line_edit(keep_weight=True))

    assert kept.status_code == 200
    weight = fact(stored(api_store, recipe.id), "i1.conversion")
    assert weight["refused"] == "kept in the written unit by an editor"
    assert weight["density_g_per_ml"] == DENSE["density_g_per_ml"]
    assert edited(weight)

    converted = edit(editor_client, stored(api_store, recipe.id), **line_edit(keep_weight=False))

    assert converted.status_code == 200
    assert fact(stored(api_store, recipe.id), "i1.conversion")["refused"] is None


def test_converting_a_weight_with_nothing_to_convert_by_is_refused(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store)  # its conversion has no density and no grams per count

    response = edit(editor_client, recipe, **line_edit(keep_weight=False))

    assert response.status_code == 422
    assert stored(api_store, recipe.id) == recipe


def kept_line() -> RecipeFacts:
    facts = beef_line()
    facts.ingredients["i1"].conversion = conversion(**{**DENSE, "refused": edits.EDITOR_KEPT})
    return facts


def test_a_line_kept_in_its_written_unit_stays_kept_with_a_new_food(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store, facts=kept_line())

    response = edit(
        editor_client, recipe, **line_edit(fdc_id=2004, portion_id=606, keep_weight=True)
    )

    assert response.status_code == 200
    weight = fact(stored(api_store, recipe.id), "i1.conversion")
    assert weight["refused"] == edits.EDITOR_KEPT
    assert weight["density_g_per_ml"] == numbers(2004, 606)["density_g_per_ml"]


def test_converting_a_new_food_with_no_portion_is_refused_naming_the_portion(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store, facts=kept_line())

    response = edit(
        editor_client, recipe, **line_edit(fdc_id=2004, portion_id=None, keep_weight=False)
    )

    assert response.status_code == 422
    assert "portion" in response.json()["detail"]
    assert "i1" in response.json()["detail"]
    assert stored(api_store, recipe.id) == recipe


def test_renaming_a_line_without_choosing_its_canonical_ingredient_is_refused(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store)
    wording = api_store.wording("beef chuck")

    response = edit(editor_client, recipe, **line_edit(name="beef chuck"))

    assert response.status_code == 422
    assert response.json()["detail"] == "Changing the wording needs a Canonical Ingredient choice"
    assert stored(api_store, recipe.id) == recipe
    assert api_store.wording("beef chuck") == wording


def test_respelling_a_line_in_the_same_wording_keeps_its_canonical_ingredient(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store)

    response = edit(editor_client, recipe, **line_edit(name="Stewing  Beef"))

    assert response.status_code == 200
    assert fact(stored(api_store, recipe.id), "i1.match")["canonical_id"] == BEEF.id


# A line's Canonical Ingredient


def test_a_new_canonical_ingredient_fixes_the_wording_across_the_collection(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store)
    unconfirmed = other(api_store, 2, beef_line())
    already = other(api_store, 3, beef_line("Stewing  Beef,", **CONFIRMED))
    elsewhere = other(api_store, 4, beef_line("beef chuck"))

    response = edit(
        editor_client,
        recipe,
        **line_edit(
            canonical={
                "kind": "new",
                "name": "Braising Beef",
                "family": "Beef",
                "store_category_id": "meat",
            },
            fdc_id=1002,
            portion_id=503,  # 1 large egg: a bare count, as each line's is
        ),
    )

    assert response.status_code == 200
    assert sorted(response.json()["also_updated"]) == sorted([unconfirmed.id, already.id])
    new = next(c for c in api_store.canonical_ingredients() if c.name == "Braising Beef")
    assert (new.family, new.store_category_id, new.confirmed) == ("beef", "meat", True)
    wording = api_store.wording("stewing beef")
    assert wording is not None
    assert (wording.canonical_id, wording.confirmed) == (new.id, True)
    for before in (recipe, unconfirmed, already):
        after = stored(api_store, before.id)
        matched = fact(after, "i1.match")
        assert (matched["canonical_id"], matched["fdc_id"], matched["portion_id"]) == (
            new.id,
            1002,
            503,
        )
        assert edited(matched)
        assert converted(after) == numbers(1002, 503)
        assert after.version == before.version + 1
        assert card(api_store, before.id)["recipe_version"] == after.version
    assert stored(api_store, elsewhere.id) == elsewhere


def test_a_new_canonical_ingredient_needs_an_fdc_food(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store)
    new = {"kind": "new", "name": "Braising Beef", "family": "beef", "store_category_id": "meat"}

    response = edit(editor_client, recipe, **line_edit(canonical=new, fdc_id=None))

    assert response.status_code == 422
    assert response.json()["detail"] == "Line i1 needs an FDC food: the closest if none fits"
    assert stored(api_store, recipe.id) == recipe


def test_an_existing_canonical_ingredient_takes_the_editors_food_not_another_lines(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store, canonicals=(BEEF, PORK))
    matched_before = beef_line("pork shoulder", canonical_id=PORK.id, fdc_id=2002, **CONFIRMED)
    matched_before.ingredients["i1"].conversion = conversion(fdc_id=2002, **DENSE)
    other(api_store, 3, matched_before)

    response = edit(
        editor_client,
        recipe,
        **line_edit(canonical={"kind": "existing", "id": PORK.id}, fdc_id=2004, portion_id=606),
    )

    assert response.status_code == 200
    saved = stored(api_store, recipe.id)
    matched = fact(saved, "i1.match")
    assert (matched["canonical_id"], matched["fdc_id"], matched["portion_id"]) == (
        PORK.id,
        2004,
        606,
    )
    assert converted(saved) == numbers(2004, 606)
    assert edited(fact(saved, "i1.conversion"))
    assert next(c for c in api_store.canonical_ingredients() if c.id == PORK.id).confirmed


# A line's FDC food


def numbers(fdc_id: int, portion_id: int | None) -> dict[str, Any]:
    """The conversion fdc.convert gives the food's portion in the synthetic FDC Snapshot."""
    food = SNAPSHOT.food(fdc_id)
    return {
        "fdc_id": fdc_id,
        "dataset": food.dataset,
        "release": SNAPSHOT.release,
        **fdc.convert(food, portion_id).model_dump(),
        "per_100g": food.per_100g.model_dump(),
    }


def converted(recipe: Recipe, line_id: str = "i1") -> dict[str, Any]:
    """The line's conversion's FDC numbers."""
    found = fact(recipe, f"{line_id}.conversion")
    return {key: found[key] for key in numbers(1001, None)}


def test_picking_a_food_and_portion_stores_its_conversion_from_the_snapshot(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store)

    response = edit(editor_client, recipe, **line_edit(fdc_id=2004, portion_id=606))

    assert response.status_code == 200
    saved = stored(api_store, recipe.id)
    matched = fact(saved, "i1.match")
    assert (matched["canonical_id"], matched["fdc_id"], matched["portion_id"]) == (
        BEEF.id,
        2004,
        606,
    )
    assert edited(matched)
    assert converted(saved) == numbers(2004, 606)
    assert converted(saved)["density_g_per_ml"] is not None
    assert edited(fact(saved, "i1.conversion"))
    assert saved.issues[0].status == "resolved"


def test_picking_a_food_with_no_portion_stores_no_portion_chosen(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store)

    response = edit(editor_client, recipe, **line_edit(fdc_id=2004, portion_id=None))

    assert response.status_code == 200
    saved = stored(api_store, recipe.id)
    assert fact(saved, "i1.match")["portion_id"] is None
    assert converted(saved)["refused"] == "no portion chosen"


@pytest.mark.parametrize(
    ("fdc_id", "portion_id"),
    [(9999, None), (2004, 501)],
    ids=["unknown food", "another food's portion"],
)
def test_a_food_or_portion_not_in_the_snapshot_is_refused_naming_the_line(
    editor_client: TestClient, api_store: Store, fdc_id: int, portion_id: int | None
) -> None:
    recipe = awaiting(api_store)

    response = edit(editor_client, recipe, **line_edit(fdc_id=fdc_id, portion_id=portion_id))

    assert response.status_code == 422
    assert "i1" in response.json()["detail"]
    assert stored(api_store, recipe.id) == recipe


def frob_line(unit: str | None, preparation: str | None = None, **match_fields: Any) -> RecipeFacts:
    """A frob root line in its written unit."""
    written = parse("frob root").model_copy(
        update={"unit": unit, "unit_kind": unit_kind(unit), "preparation": preparation}
    )
    return RecipeFacts(
        ingredients={
            "i1": IngredientFacts(
                parse=written, match=match(**match_fields), conversion=conversion()
            )
        }
    )


FROB: dict[str, Any] = {
    "name": "frob root",
    "unit": "knobs",
    "canonical": {"kind": "existing", "id": BEEF.id},
}


@pytest.mark.parametrize(
    ("picked", "unit", "portion_id"),
    [
        (611, "tbsp", 612),  # a knob gives no density, so the food's first portion that does
        (612, "cups", 612),  # a density works for every volume
        (612, "knobs", 611),  # the food's portion counted in the line's word
        (611, "knob", 611),  # the same count word, singular or plural
        (611, "g", 611),  # a weight needs no portion: it stays as picked
    ],
    ids=["volume fallback", "volume", "count word", "same count", "mass"],
)
def test_a_food_pick_spreads_the_portion_that_fits_each_lines_unit(
    editor_client: TestClient, api_store: Store, picked: int, unit: str, portion_id: int
) -> None:
    recipe = awaiting(api_store, facts=frob_line("knobs"))
    sharing = other(api_store, 2, frob_line(unit))

    response = edit(editor_client, recipe, **line_edit(**FROB, fdc_id=2009, portion_id=picked))

    assert response.status_code == 200
    assert response.json()["also_updated"] == [sharing.id]
    after = stored(api_store, sharing.id)
    matched = fact(after, "i1.match")
    assert (matched["fdc_id"], matched["portion_id"]) == (2009, portion_id)
    assert edited(matched)
    assert converted(after) == numbers(2009, portion_id)
    assert not [issue for issue in after.issues if issue.status == "open"]


@pytest.mark.parametrize("unit", ["slices", None], ids=["another count", "a bare count"])
def test_a_food_pick_with_no_portion_for_a_lines_unit_asks_for_one(
    editor_client: TestClient, api_store: Store, unit: str | None
) -> None:
    recipe = awaiting(api_store, facts=frob_line("knobs"))
    sharing = other(api_store, 2, frob_line(unit))

    response = edit(editor_client, recipe, **line_edit(**FROB, fdc_id=2009, portion_id=611))

    assert response.status_code == 200
    after = stored(api_store, sharing.id)
    matched = fact(after, "i1.match")
    assert (matched["fdc_id"], matched["portion_id"]) == (2009, None)
    assert converted(after) == numbers(2009, None)
    (opened,) = [issue for issue in after.issues if issue.status == "open"]
    assert opened.fact_id == "i1.conversion"
    assert "portion" in opened.reason
    # It proposes no correction to accept: an editor picks a portion by editing the line.
    assert (opened.before, opened.after) == (None, None)
    assert card(api_store, sharing.id)["needs_review"]["flagged"] == 1


def test_a_food_pick_spreads_the_chosen_portion_to_a_line_with_no_amount(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store, facts=frob_line("knobs"))
    to_taste = parse("frob root").model_copy(update={"quantity": None})
    facts = RecipeFacts(
        ingredients={"i1": IngredientFacts(parse=to_taste, match=match(), conversion=conversion())}
    )
    sharing = other(api_store, 2, facts)

    response = edit(editor_client, recipe, **line_edit(**FROB, fdc_id=2009, portion_id=611))

    assert response.status_code == 200
    after = stored(api_store, sharing.id)
    # No portion gives "frob root, to taste" a weight, so it takes the chosen one as it is.
    assert fact(after, "i1.match")["portion_id"] == 611
    assert converted(after) == numbers(2009, 611)
    assert not [issue for issue in after.issues if issue.status == "open"]


def test_a_food_pick_spreads_the_clove_portion_to_a_clove_s_line(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store, facts=frob_line("cloves"))
    sharing = other(api_store, 2, frob_line("clove(s)"))

    response = edit(
        editor_client,
        recipe,
        **line_edit(**{**FROB, "unit": "cloves"}, fdc_id=2007, portion_id=608),
    )

    assert response.status_code == 200
    after = stored(api_store, sharing.id)
    assert fact(after, "i1.match")["portion_id"] == 608
    assert not [issue for issue in after.issues if issue.status == "open"]


def test_a_food_pick_reaches_only_lines_with_the_same_preparation(
    editor_client: TestClient, api_store: Store
) -> None:
    # "1 lemon, juiced" takes the juice; "1 lemon, cut in wedges" and "1 lemon" keep the fruit.
    recipe = awaiting(api_store, facts=frob_line("knobs", "juiced"))
    same = other(api_store, 2, frob_line("knobs", "juiced"))
    quartered = other(api_store, 3, frob_line("knobs", "quartered"))
    bare = other(api_store, 4, frob_line("knobs"))

    response = edit(
        editor_client,
        recipe,
        **line_edit(**FROB, preparation=" Juiced.", fdc_id=2009, portion_id=611),
    )

    assert response.status_code == 200
    assert response.json()["also_updated"] == [same.id]
    assert fact(stored(api_store, same.id), "i1.match")["fdc_id"] == 2009
    assert stored(api_store, quartered.id) == quartered
    assert stored(api_store, bare.id) == bare


def test_a_food_pick_on_a_line_with_no_preparation_skips_one_with_a_preparation(
    editor_client: TestClient, api_store: Store
) -> None:
    # Exactly the same preparation: "kosher salt" doesn't reach "kosher salt, divided".
    recipe = awaiting(api_store, facts=frob_line("knobs"))
    divided = other(api_store, 2, frob_line("knobs", "divided"))

    response = edit(editor_client, recipe, **line_edit(**FROB, fdc_id=2009, portion_id=611))

    assert response.status_code == 200
    assert response.json()["also_updated"] == []
    assert stored(api_store, divided.id) == divided


def test_a_canonical_change_asks_for_the_food_of_a_line_with_another_preparation(
    editor_client: TestClient, api_store: Store
) -> None:
    # "cream" moves from ice cream to cream: "2 tbsp cream, whipped" takes cream, keeps its food
    # and asks an editor to pick one.
    recipe = awaiting(api_store, facts=frob_line("knobs"), canonicals=(BEEF, PORK))
    no_portion = issue(5, "i1.conversion", before=None, after=None, reason="No portion fits")
    whipped = other(api_store, 2, frob_line("knobs", "whipped", **CONFIRMED), (no_portion,))
    to_pork: dict[str, Any] = {**FROB, "canonical": {"kind": "existing", "id": PORK.id}}

    response = edit(editor_client, recipe, **line_edit(**to_pork, fdc_id=2009, portion_id=611))

    assert response.status_code == 200
    assert response.json()["also_updated"] == [whipped.id]
    after = stored(api_store, whipped.id)
    matched = fact(after, "i1.match")
    assert (matched["canonical_id"], matched["fdc_id"], matched["portion_id"]) == (
        PORK.id,
        1001,
        None,
    )
    # Nobody confirmed the old food under the new Canonical Ingredient: the match keeps its
    # provenance and confidence, unconfirmed.
    assert unconfirmed(matched)
    assert (matched["provenance"], matched["confidence"]) == ("llm", 0.8)
    assert fact(after, "i1.conversion") == fact(whipped, "i1.conversion")
    # The kept conversion's open issue still stands next to the ask for a food.
    assert open_issues(after) == ["i1.conversion", "i1.match"]
    (opened,) = [found for found in after.issues if found.status == "open" and found != no_portion]
    assert "FDC food" in opened.reason
    assert (opened.before, opened.after) == (None, None)
    assert card(api_store, whipped.id)["needs_review"]["flagged"] == 1


def test_an_unmatched_line_with_another_preparation_takes_the_food_and_is_asked_about_it(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store, facts=frob_line("knobs"))
    written = parse("frob root").model_copy(update={"unit": "knobs", "preparation": "whipped"})
    unmatched = other(api_store, 2, RecipeFacts(ingredients={"i1": IngredientFacts(parse=written)}))

    response = edit(editor_client, recipe, **line_edit(**FROB, fdc_id=2009, portion_id=611))

    assert response.status_code == 200
    after = stored(api_store, unmatched.id)
    matched = fact(after, "i1.match")
    assert (matched["canonical_id"], matched["fdc_id"], matched["portion_id"]) == (
        BEEF.id,
        2009,
        611,
    )
    # Picked for another preparation, the food is nobody's confirmed choice for this line.
    assert unconfirmed(matched)
    assert (matched["provenance"], matched["confidence"]) == ("editor", 1)
    assert unconfirmed(fact(after, "i1.conversion"))
    (opened,) = [issue for issue in after.issues if issue.status == "open"]
    assert opened.fact_id == "i1.match"
    # The pick kept the Canonical Ingredient, so the ask mustn't say it changed.
    assert "Canonical Ingredient" not in opened.reason


def unconfirmed(found: dict[str, Any]) -> bool:
    return not found["confirmed"] and not any(
        found[key] for key in ("confirmed_by", "confirmed_at", "confirm_batch")
    )


def open_issues(recipe: Recipe) -> list[str]:
    return [issue.fact_id for issue in recipe.issues if issue.status == "open"]


TO_PORK: dict[str, Any] = {**FROB, "canonical": {"kind": "existing", "id": PORK.id}}


def test_picking_the_food_settles_the_ask(editor_client: TestClient, api_store: Store) -> None:
    recipe = awaiting(api_store, facts=frob_line("knobs"), canonicals=(BEEF, PORK))
    whipped = other(api_store, 2, frob_line("knobs", "whipped"))
    edit(editor_client, recipe, **line_edit(**TO_PORK, fdc_id=2009, portion_id=611))
    asked = stored(api_store, whipped.id)
    assert open_issues(asked) == ["i1.match"]
    assert unconfirmed(fact(asked, "i1.match"))

    response = edit(
        editor_client,
        asked,
        **line_edit(**TO_PORK, preparation="whipped", fdc_id=2009, portion_id=611),
    )

    assert response.status_code == 200
    answered = stored(api_store, whipped.id)
    assert not [issue for issue in answered.issues if issue.status == "open"]
    assert fact(answered, "i1.match")["fdc_id"] == 2009


def test_saving_the_asked_line_unchanged_settles_the_ask(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store, facts=frob_line("knobs"), canonicals=(BEEF, PORK))
    whipped = other(api_store, 2, frob_line("knobs", "whipped"))
    edit(editor_client, recipe, **line_edit(**TO_PORK, fdc_id=2009, portion_id=611))
    asked = stored(api_store, whipped.id)
    assert open_issues(asked) == ["i1.match"]
    assert unconfirmed(fact(asked, "i1.match"))

    # The editor checks the kept food and saves the line as it stands.
    response = edit(
        editor_client,
        asked,
        **line_edit(name="frob root", unit="knobs", preparation="whipped", fdc_id=1001),
    )

    assert response.status_code == 200
    answered = stored(api_store, whipped.id)
    assert open_issues(answered) == []
    matched = fact(answered, "i1.match")
    assert (matched["canonical_id"], matched["fdc_id"]) == (PORK.id, 1001)
    assert matched["confirmed"]


def test_a_food_pick_reaches_the_edited_recipes_own_lines_by_preparation(
    editor_client: TestClient, api_store: Store
) -> None:
    line = frob_line("knobs").ingredients["i1"]
    whipped = frob_line("knobs", "whipped").ingredients["i1"]
    facts = RecipeFacts(ingredients={"i1": line, "i2": line, "i3": whipped})
    recipe = awaiting(api_store, facts=facts, issues=[], canonicals=(BEEF, PORK))

    response = edit(editor_client, recipe, **line_edit(**TO_PORK, fdc_id=2009, portion_id=611))

    assert response.status_code == 200
    saved = stored(api_store, recipe.id)
    same = fact(saved, "i2.match")
    assert (same["canonical_id"], same["fdc_id"], same["portion_id"]) == (PORK.id, 2009, 611)
    assert edited(same)
    other_way = fact(saved, "i3.match")
    assert (other_way["canonical_id"], other_way["fdc_id"]) == (PORK.id, 1001)
    assert unconfirmed(other_way)
    assert open_issues(saved) == ["i3.match"]


def test_a_ready_recipe_asked_for_a_food_stays_ready_and_flagged(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store, facts=frob_line("knobs"), canonicals=(BEEF, PORK))
    whipped = other(api_store, 2, frob_line("knobs", "whipped", **CONFIRMED))
    ready = api_store.update_recipe(whipped.model_copy(update={"status": "ready"}))

    response = edit(editor_client, recipe, **line_edit(**TO_PORK, fdc_id=2009, portion_id=611))

    assert response.status_code == 200
    after = stored(api_store, ready.id)
    assert open_issues(after) == ["i1.match"]
    assert after.status == "ready"
    assert card(api_store, ready.id)["needs_review"]["flagged"] == 1


def test_a_line_prepared_another_way_already_matched_to_the_canonical_ingredient_is_left(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store, facts=frob_line("knobs"), canonicals=(BEEF, PORK))
    whipped = other(api_store, 2, frob_line("knobs", "whipped", canonical_id=PORK.id))

    response = edit(editor_client, recipe, **line_edit(**TO_PORK, fdc_id=2009, portion_id=611))

    assert response.status_code == 200
    assert response.json()["also_updated"] == []
    assert stored(api_store, whipped.id) == whipped


def test_changing_the_canonical_ingredient_back_leaves_one_ask(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store, facts=frob_line("knobs"), canonicals=(BEEF, PORK))
    whipped = other(api_store, 2, frob_line("knobs", "whipped"))
    edit(editor_client, recipe, **line_edit(**TO_PORK, fdc_id=2009, portion_id=611))

    response = edit(
        editor_client,
        stored(api_store, recipe.id),
        **line_edit(**FROB, fdc_id=2009, portion_id=611),
    )

    assert response.status_code == 200
    after = stored(api_store, whipped.id)
    assert fact(after, "i1.match")["canonical_id"] == BEEF.id
    assert open_issues(after) == ["i1.match"]


def test_a_picked_clove_never_reaches_a_spoonful_of_garlic(
    editor_client: TestClient, api_store: Store
) -> None:
    cloves = parse("snorp garlic").model_copy(update={"unit": "cloves"})
    spoon = parse("snorp garlic").model_copy(update={"unit": "tbsp", "unit_kind": "volume"})
    facts = RecipeFacts(
        ingredients={
            "i1": IngredientFacts(parse=cloves, match=match(), conversion=conversion()),
            "i2": IngredientFacts(parse=spoon, match=match(), conversion=conversion()),
        }
    )
    recipe = awaiting(api_store, facts=facts, issues=[issue(1), issue(2, "i2.match")])
    spooned = other(api_store, 2, RecipeFacts(ingredients={"i1": facts.ingredients["i2"]}))
    ready = api_store.update_recipe(spooned.model_copy(update={"status": "ready"}))

    response = edit(
        editor_client,
        recipe,
        **line_edit(name="snorp garlic", unit="cloves", fdc_id=2007, portion_id=608),
    )

    assert response.status_code == 200
    saved = stored(api_store, recipe.id)
    assert fact(saved, "i1.match")["portion_id"] == 608
    # The same recipe's spoonful takes the garlic but not the clove, and asks for a portion.
    spooned = fact(saved, "i2.match")
    assert (spooned["fdc_id"], spooned["portion_id"]) == (2007, None)
    assert [(i.fact_id, i.status) for i in saved.issues] == [
        ("i1.match", "resolved"),
        ("i2.match", "resolved"),
        ("i2.conversion", "open"),
    ]
    elsewhere = stored(api_store, ready.id)
    assert fact(elsewhere, "i1.match")["fdc_id"] == 2007
    assert converted(elsewhere)["refused"] == "no portion chosen"
    assert [i.fact_id for i in elsewhere.issues if i.status == "open"] == ["i1.conversion"]
    assert elsewhere.status == "ready"


def test_resaving_a_line_with_its_food_unchanged_reaches_no_other_recipe(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store)
    sharing = other(api_store, 2, beef_line())

    response = edit(editor_client, recipe, **line_edit())

    assert response.status_code == 200
    assert shared(response) == ([], [], [])
    assert stored(api_store, sharing.id) == sharing


@pytest.mark.parametrize(
    "canonical",
    [
        {"kind": "existing", "id": PORK.id},
        {"kind": "new", "name": "Pork", "family": "pork", "store_category_id": "nowhere"},
    ],
    ids=["unknown canonical", "unknown store category"],
)
def test_an_unknown_canonical_ingredient_or_store_category_is_refused(
    editor_client: TestClient, api_store: Store, canonical: dict[str, str]
) -> None:
    recipe = awaiting(api_store)

    response = edit(editor_client, recipe, **line_edit(canonical=canonical))

    assert response.status_code == 422
    assert stored(api_store, recipe.id) == recipe


def test_editing_a_stale_version_is_a_conflict_that_changes_nothing(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store)
    sharing = other(api_store, 2, beef_line())
    wording = api_store.wording("stewing beef")
    canonicals = api_store.canonical_ingredients()

    response = edit(
        editor_client,
        recipe,
        version=recipe.version - 1,
        **line_edit(canonical={"kind": "existing", "id": BEEF.id}),
    )

    assert response.status_code == 409
    assert stored(api_store, recipe.id) == recipe
    assert stored(api_store, sharing.id) == sharing
    assert api_store.wording("stewing beef") == wording
    assert api_store.canonical_ingredients() == canonicals


def test_renaming_a_line_with_a_canonical_ingredient_fixes_the_new_wording(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store, canonicals=(BEEF, PORK))
    renamed = other(api_store, 2, beef_line("pork shoulder"))
    unrenamed = other(api_store, 3, beef_line())
    old_wording = api_store.wording("stewing beef")

    response = edit(
        editor_client,
        recipe,
        **line_edit(name="pork shoulder", canonical={"kind": "existing", "id": PORK.id}),
    )

    assert response.status_code == 200
    assert response.json()["also_updated"] == [renamed.id]
    wording = api_store.wording("pork shoulder")
    assert wording is not None
    assert (wording.canonical_id, wording.confirmed) == (PORK.id, True)
    assert api_store.wording("stewing beef") == old_wording
    assert fact(stored(api_store, renamed.id), "i1.match")["canonical_id"] == PORK.id
    assert stored(api_store, unrenamed.id) == unrenamed


def test_a_sharing_recipe_that_changed_meanwhile_is_read_again(
    editor_client: TestClient, api_store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    recipe = awaiting(api_store)
    sharing = other(api_store, 2, beef_line())
    meanwhile = Difficulty(prep=1, cook=1, cleanup=1)
    update = api_store.update_recipe
    raced: list[str] = []

    def racing(changed: Recipe) -> Recipe:
        if changed.id == sharing.id and not raced:
            raced.append(changed.id)
            update(stored(api_store, sharing.id).model_copy(update={"difficulty": meanwhile}))
        return update(changed)

    monkeypatch.setattr(api_store, "update_recipe", racing)

    response = edit(
        editor_client, recipe, **line_edit(canonical={"kind": "existing", "id": BEEF.id})
    )

    assert response.status_code == 200
    assert shared(response) == ([sharing.id], [], [])
    after = stored(api_store, sharing.id)
    assert edited(fact(after, "i1.match"))
    assert after.difficulty == meanwhile
    assert after.version == sharing.version + 2


def test_a_sharing_recipe_that_keeps_changing_is_reported_not_updated(
    editor_client: TestClient, api_store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    recipe = awaiting(api_store)
    sharing = other(api_store, 2, beef_line())
    update = api_store.update_recipe

    def conflicting(changed: Recipe) -> Recipe:
        if changed.id == sharing.id:
            raise VersionConflict(changed.id)
        return update(changed)

    monkeypatch.setattr(api_store, "update_recipe", conflicting)

    response = edit(
        editor_client, recipe, **line_edit(canonical={"kind": "existing", "id": BEEF.id})
    )

    assert response.status_code == 200
    assert shared(response) == ([], [sharing.id], [])
    assert stored(api_store, sharing.id) == sharing
    saved = stored(api_store, recipe.id)
    assert saved.version == recipe.version + 1
    assert edited(fact(saved, "i1.match"))


def test_a_sharing_recipe_the_match_would_make_too_big_is_reported_too_big(
    editor_client: TestClient, api_store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    recipe = awaiting(api_store)
    sharing = other(api_store, 2, beef_line())
    monkeypatch.setattr(edits, "MAX_RECIPE_BYTES", 100)

    response = edit(
        editor_client, recipe, **line_edit(canonical={"kind": "existing", "id": BEEF.id})
    )

    assert response.status_code == 200
    assert shared(response) == ([], [], [sharing.id])
    assert stored(api_store, sharing.id) == sharing


def test_picking_the_same_canonical_ingredient_again_retries_the_recipes_that_kept_changing(
    editor_client: TestClient, api_store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    recipe = awaiting(api_store, canonicals=(BEEF, PORK))
    sharing = other(api_store, 2, beef_line())
    update = api_store.update_recipe

    def conflicting(changed: Recipe) -> Recipe:
        if changed.id == sharing.id:
            raise VersionConflict(changed.id)
        return update(changed)

    monkeypatch.setattr(api_store, "update_recipe", conflicting)
    pork = line_edit(canonical={"kind": "existing", "id": PORK.id})
    first = edit(editor_client, recipe, **pork)
    assert shared(first) == ([], [sharing.id], [])
    monkeypatch.setattr(api_store, "update_recipe", update)

    again = edit(editor_client, stored(api_store, recipe.id), **pork)

    assert again.status_code == 200
    assert shared(again) == ([sharing.id], [], [])
    matched = fact(stored(api_store, sharing.id), "i1.match")
    assert matched["canonical_id"] == PORK.id
    assert edited(matched)


def test_saving_a_line_with_its_canonical_ingredient_unchanged_leaves_other_recipes(
    editor_client: TestClient, api_store: Store
) -> None:
    chicken = PORK.model_copy(update={"name": "chicken stock", "family": "stock"})
    vegetable = PORK.model_copy(
        update={"id": "01K7Q0000000000000000000C3", "name": "vegetable stock", "family": "stock"}
    )
    recipe = awaiting(
        api_store,
        facts=beef_line("stock", canonical_id=chicken.id, **CONFIRMED),
        canonicals=(chicken, vegetable),
    )
    fixed = Wording(
        wording="stock", canonical_id=chicken.id, confirmed=True, schema_version=SCHEMA_VERSION
    )
    recipe = api_store.review_recipe(recipe, [], [], overwrite_wordings=[fixed])
    vegetables = other(api_store, 2, beef_line("stock", canonical_id=vegetable.id, **CONFIRMED))

    response = edit(
        editor_client,
        recipe,
        **line_edit(name="stock", quantity={"low": 2, "high": 2}, unit="cup", preparation=None),
    )

    assert response.status_code == 200
    assert shared(response) == ([], [], [])
    assert stored(api_store, vegetables.id) == vegetables
    assert fact(stored(api_store, recipe.id), "i1.parse")["quantity"] == {"low": 2, "high": 2}


# Refused edits


def test_editing_a_pending_recipe_is_refused(editor_client: TestClient, api_store: Store) -> None:
    recipe = api_store.add_recipe(STEW)

    response = edit(editor_client, recipe, kind="difficulty", prep=1, cook=2, cleanup=3)

    assert response.status_code == 409
    assert response.json()["detail"] == "A Pending recipe has no facts to edit yet"
    assert stored(api_store, recipe.id) == recipe


def test_an_edit_that_makes_the_recipe_too_big_is_refused(
    editor_client: TestClient, api_store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    recipe = awaiting(api_store)
    monkeypatch.setattr(api, "MAX_RECIPE_BYTES", len(recipe.model_dump_json().encode()))

    response = edit(editor_client, recipe, **line_edit(preparation="cubed " * 20))

    assert response.status_code == 422
    assert stored(api_store, recipe.id) == recipe


def test_only_an_editor_can_edit(client: TestClient, api_store: Store) -> None:
    recipe = awaiting(api_store)
    body = {"version": recipe.version, "edit": line_edit(name="beef chuck")}
    path = f"/api/recipes/{recipe.id}/edit"

    by_a_visitor = client.post(path, json=body)
    with_a_wrong_token = client.post(
        path, json=body, headers={next(iter(EDITOR)): SERVICE_TOKEN + "x"}
    )

    assert by_a_visitor.status_code == 403
    assert with_a_wrong_token.status_code in {401, 403}
    assert stored(api_store, recipe.id) == recipe


# Steps


def stew_step(portion: float = 1.0) -> StepFacts:
    """The stew's third step, "Add the stock and barley, cover and simmer 1 1/2 hours."."""
    return StepFacts(
        segments=SegmentsFact(
            provenance="llm",
            confidence=0.8,
            estimated=False,
            segments=[
                TextSegment(v="Add "),
                IngredientSegment(ref="i8", written="the stock", portion=portion),
                TextSegment(v=" and "),
                IngredientSegment(ref="i7", written="barley", portion=1),
                TextSegment(v=", cover and simmer "),
                DurationSegment(low_s=5400, high_s=5400, written="1 1/2 hours"),
                TextSegment(v="."),
            ],
        ),
        uses=uses(uses=[{"ref": "i8", "portion": portion}, {"ref": "i7", "portion": 1}]),
    )


def test_editing_a_step_sets_its_portions_and_timer(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store, facts=FACTS.model_copy(update={"steps": {"s3": stew_step()}}))

    response = edit(
        editor_client,
        recipe,
        kind="step",
        step_id="s3",
        portions=[0.5, 1],
        durations=[{"low_s": 3600, "high_s": 6000}],
    )

    assert response.status_code == 200
    saved = stored(api_store, recipe.id)
    segments = fact(saved, "s3.segments")
    assert [s["portion"] for s in segments["segments"] if s["t"] == "ingredient"] == [0.5, 1]
    timer = next(s for s in segments["segments"] if s["t"] == "duration")
    assert (timer["low_s"], timer["high_s"], timer["written"]) == (3600, 6000, "1 1/2 hours")
    assert fact(saved, "s3.uses")["uses"] == [
        {"ref": "i8", "portion": 0.5},
        {"ref": "i7", "portion": 1},
    ]
    assert edited(segments)
    assert edited(fact(saved, "s3.uses"))


@pytest.mark.parametrize(
    ("portions", "durations"),
    [
        ([1, 1], [{"low_s": 3600, "high_s": 3600}]),  # with s1's half, more than all the stock
        ([0.5], [{"low_s": 3600, "high_s": 3600}]),  # one portion short
        ([0.5, 1], [{"low_s": 3600, "high_s": 60}]),  # a timer running backwards
        ([0.5, 1], [{"low_s": 0, "high_s": 60}]),  # a timer of no time
        ([0.5, 1], []),  # a timer short
    ],
    ids=["over", "portions short", "backwards", "zero", "durations short"],
)
def test_an_impossible_step_edit_is_refused(
    editor_client: TestClient,
    api_store: Store,
    portions: list[float],
    durations: list[dict[str, int]],
) -> None:
    halved = StepFacts(uses=uses(uses=[{"ref": "i8", "portion": 0.5}]))
    steps = {"s1": halved, "s3": stew_step(0.5)}
    recipe = awaiting(api_store, facts=FACTS.model_copy(update={"steps": steps}))

    response = edit(
        editor_client, recipe, kind="step", step_id="s3", portions=portions, durations=durations
    )

    assert response.status_code == 422
    assert stored(api_store, recipe.id) == recipe


# Substitutions


def with_swaps(*wordings: str) -> RecipeFacts:
    items = [{**SWAP, "wording": wording} for wording in wordings]
    swaps = SubstitutionsFact.model_validate(
        {"provenance": "llm", "confidence": 0.6, "estimated": True, "items": items}
    )
    line = FACTS.ingredients["i1"].model_copy(update={"substitutions": swaps})
    return FACTS.model_copy(update={"ingredients": {**FACTS.ingredients, "i1": line}})


def test_editing_a_substitution_sets_its_ratio_and_note(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(
        api_store,
        facts=with_swaps("beef chuck", "lamb"),
        issues=[issue(2, "i1.substitutions")],
    )

    response = edit(
        editor_client,
        recipe,
        kind="substitution",
        line_id="i1",
        index=1,
        ratio=0.75,
        note="lamb is richer",
    )

    assert response.status_code == 200
    saved = stored(api_store, recipe.id)
    swaps = fact(saved, "i1.substitutions")
    assert [(i["ratio"], i["note"]) for i in swaps["items"]] == [
        (1, SWAP["note"]),
        (0.75, "lamb is richer"),
    ]
    assert edited(swaps)
    assert not swaps["estimated"]
    assert saved.issues[0].status == "resolved"


def test_removing_the_last_substitution_leaves_none(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store, facts=with_swaps("beef chuck", "lamb"))

    first = edit(editor_client, recipe, kind="remove_substitution", line_id="i1", index=0)
    assert first.status_code == 200
    assert [
        i["wording"] for i in fact(stored(api_store, recipe.id), "i1.substitutions")["items"]
    ] == ["lamb"]
    last = edit(
        editor_client,
        stored(api_store, recipe.id),
        kind="remove_substitution",
        line_id="i1",
        index=0,
    )

    assert last.status_code == 200
    assert stored(api_store, recipe.id).facts.ingredients["i1"].substitutions is None


def test_editing_a_substitution_the_line_lacks_is_refused(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store, facts=with_swaps("beef chuck"))

    response = edit(editor_client, recipe, kind="remove_substitution", line_id="i1", index=1)

    assert response.status_code == 422


# Difficulty


def test_editing_the_difficulty_sets_the_recipes_own(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store)

    response = edit(editor_client, recipe, kind="difficulty", prep=1, cook=2, cleanup=3)

    assert response.status_code == 200
    saved = stored(api_store, recipe.id)
    suggested = fact(saved, "difficulty")
    assert (suggested["prep"], suggested["cook"], suggested["cleanup"]) == (1, 2, 3)
    assert edited(suggested)
    assert saved.difficulty is not None
    assert saved.difficulty.model_dump() == {"prep": 1, "cook": 2, "cleanup": 3}
    assert not card(api_store, recipe.id)["difficulty_suggested"]


def test_an_edit_that_leaves_nothing_to_check_makes_the_recipe_ready(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store, facts=RecipeFacts(difficulty=FACTS.difficulty), issues=[])

    response = edit(editor_client, recipe, kind="difficulty", prep=1, cook=2, cleanup=3)

    assert response.json()["ready"]
    assert stored(api_store, recipe.id).status == "ready"
