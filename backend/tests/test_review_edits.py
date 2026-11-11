"""An editor edits a fact from its Review Item: a line, a step, a substitution or the Difficulty.
Each edit is saved Confirmed with provenance `editor`, and a line's new Canonical Ingredient fixes
its wording for every recipe in the Collection.
"""

from typing import TYPE_CHECKING, Any

import pytest
from conftest import EDITOR, SERVICE_TOKEN
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

from recipes import api, edits
from recipes.models import (
    MASS_UNITS,
    SCHEMA_VERSION,
    VOLUME_UNITS,
    CanonicalIngredient,
    Difficulty,
    DurationSegment,
    IngredientFacts,
    IngredientSegment,
    Recipe,
    RecipeFacts,
    SegmentsFact,
    StepFacts,
    SubstitutionsFact,
    TextSegment,
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
        "preparation": "cubed",
        **fields,
    }


def edited(found: dict[str, Any]) -> bool:
    return all(found[key] == value for key, value in EDITED.items()) and not found["confirm_batch"]


def other(store: Store, n: int, facts: RecipeFacts, **fields: object) -> Recipe:
    """Another stew in the Collection, enriched without learning anything new."""
    return awaiting(
        store,
        facts=facts,
        issues=[],
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

    response = edit(editor_client, recipe, **line_edit("i5", name="carrots", unit=None))

    assert response.status_code == 200
    assert fact(stored(api_store, recipe.id), "i5.parse")["name"] == "carrots"


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
            }
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
        assert matched["canonical_id"] == new.id
        # A new Canonical Ingredient has no FDC food yet, so nothing is made up for it.
        assert (matched["fdc_id"], matched["portion_id"]) == (None, None)
        assert edited(matched)
        assert after.facts.ingredients["i1"].conversion is None
        assert after.version == before.version + 1
        assert card(api_store, before.id)["recipe_version"] == after.version
    assert stored(api_store, elsewhere.id) == elsewhere


def test_an_existing_canonical_ingredient_copies_its_food_from_a_confirmed_line(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store, canonicals=(BEEF, PORK))
    weight = {**DENSE, "estimated": True}
    other(api_store, 2, beef_line("pork", canonical_id=PORK.id, fdc_id=2001))
    donor = beef_line("pork shoulder", canonical_id=PORK.id, fdc_id=2002, **CONFIRMED)
    donor.ingredients["i1"].conversion = conversion(fdc_id=2002, **weight)
    other(api_store, 3, donor)

    response = edit(
        editor_client, recipe, **line_edit(canonical={"kind": "existing", "id": PORK.id})
    )

    assert response.status_code == 200
    saved = stored(api_store, recipe.id)
    assert (fact(saved, "i1.match")["canonical_id"], fact(saved, "i1.match")["fdc_id"]) == (
        PORK.id,
        2002,
    )
    copied = fact(saved, "i1.conversion")
    assert (copied["fdc_id"], copied["density_g_per_ml"], copied["estimated"]) == (2002, 1.05, True)
    assert edited(copied)
    assert next(c for c in api_store.canonical_ingredients() if c.id == PORK.id).confirmed


def test_an_existing_canonical_ingredient_no_line_matches_has_no_food(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store, canonicals=(BEEF, PORK))

    response = edit(
        editor_client, recipe, **line_edit(canonical={"kind": "existing", "id": PORK.id})
    )

    assert response.status_code == 200
    saved = stored(api_store, recipe.id)
    assert fact(saved, "i1.match")["fdc_id"] is None
    assert saved.facts.ingredients["i1"].conversion is None


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
    assert (response.json()["also_updated"], response.json()["not_updated"]) == ([sharing.id], [])
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
    assert (response.json()["also_updated"], response.json()["not_updated"]) == ([], [sharing.id])
    assert stored(api_store, sharing.id) == sharing
    saved = stored(api_store, recipe.id)
    assert saved.version == recipe.version + 1
    assert edited(fact(saved, "i1.match"))


def test_a_sharing_recipe_the_match_would_make_too_big_is_reported_not_updated(
    editor_client: TestClient, api_store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    recipe = awaiting(api_store)
    sharing = other(api_store, 2, beef_line())
    monkeypatch.setattr(edits, "MAX_RECIPE_BYTES", 100)

    response = edit(
        editor_client, recipe, **line_edit(canonical={"kind": "existing", "id": BEEF.id})
    )

    assert response.status_code == 200
    assert (response.json()["also_updated"], response.json()["not_updated"]) == ([], [sharing.id])
    assert stored(api_store, sharing.id) == sharing


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
