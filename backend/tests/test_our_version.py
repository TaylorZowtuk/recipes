"""An editor saves or removes a recipe's Our Version in the batched Edit. Its edited and added
lines carry the editor's own facts, Confirmed, in its own facts map; its steps wait for enrich
under the Our Version Status. The Original's facts change only when a line's pick fixes a wording.
"""

from typing import TYPE_CHECKING, Any

import pytest
from conftest import EDITOR
from test_enrichment_review import BEEF, CONFIRMED, FACTS, STEW, awaiting, card, parse, stored
from test_review_edits import PORK, beef_line, numbers, other

from recipes.models import IngredientFacts, Quantity, RecipeFacts
from recipes.our_version import kitchen_number, line_text
from recipes.seed import CHICKEN_ID, GARLIC, load

if TYPE_CHECKING:
    from fastapi.testclient import TestClient
    from httpx2 import Response

    from recipes.images import ImageStore
    from recipes.models import ParseFact, Recipe
    from recipes.store import Store

NEW_TOMATOES = {
    "kind": "new",
    "name": "Diced Tomatoes",
    "family": "tomato",
    "store_category_id": "aisles",
}


def save(
    client: TestClient, recipe: Recipe, our_version: dict[str, Any], version: int | None = None
) -> Response:
    operation = {"op": "set_our_version", "our_version": our_version}
    body = {"version": recipe.version if version is None else version, "operations": [operation]}
    return client.patch(f"/api/recipes/{recipe.id}", json=body, headers=EDITOR)


def remove(client: TestClient, recipe: Recipe) -> Response:
    body = {"version": recipe.version, "operations": [{"op": "remove_our_version"}]}
    return client.patch(f"/api/recipes/{recipe.id}", json=body, headers=EDITOR)


def line(**fields: Any) -> dict[str, Any]:
    """The stew's beef line in Our Version: less of it, the same food."""
    return {
        "quantity": {"low": 450, "high": 450},
        "unit": "g",
        "name": "stewing beef",
        "preparation": None,
        "fdc_id": 1001,
        "portion_id": None,
        **fields,
    }


def tomatoes(**fields: Any) -> dict[str, Any]:
    """An added line with a new wording, and so a Canonical Ingredient and an FDC food."""
    return line(
        **{
            "quantity": {"low": 2, "high": 2},
            "unit": "can",
            "name": "diced tomatoes",
            "preparation": "drained",
            "canonical": NEW_TOMATOES,
            "fdc_id": 1002,
            "portion_id": 503,
            "after": "i1",
            **fields,
        }
    )


def drained_tomatoes() -> RecipeFacts:
    """Another recipe's line with the added line's wording and preparation."""
    facts = beef_line("diced tomatoes")
    line = facts.ingredients["i1"]
    line.parse = parse("diced tomatoes").model_copy(update={"preparation": "drained"})
    return facts


def lines(
    edit: dict[str, Any] | None = None,
    remove: list[str] | None = None,
    add: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {"edit": edit or {}, "remove": remove or [], "add": add or []}


def ready(store: Store, facts: RecipeFacts = FACTS) -> Recipe:
    """The stew Ready, with nothing in Our Version."""
    return awaiting(store, facts=facts, issues=[], status="ready")


def editors(fact: dict[str, Any]) -> bool:
    return (
        fact["provenance"] == "editor"
        and fact["confirmed"]
        and fact["confirmed_by"] == "editor"
        and fact["confidence"] == 1
        and fact["confirm_batch"] is None
    )


# Saving


def test_saving_our_version_stores_the_editors_lines_and_steps(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = ready(api_store)

    response = save(
        editor_client,
        recipe,
        {
            "ingredients": lines(edit={"i1": line()}, remove=["i9"], add=[tomatoes()]),
            "steps": lines(edit={"s2": {"text": "Brown the beef in two batches."}}),
            "note": "Less beef, more tomato.",
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["version"] == recipe.version + 1
    ours = body["our_version"]
    assert ours["ingredients"]["edit"]["i1"] == {"text": "450 g stewing beef", "component": None}
    beef = ours["facts"]["ingredients"]["i1"]
    assert beef["parse"]["quantity"] == {"low": 450, "high": 450}
    assert all(editors(beef[kind]) for kind in ("parse", "match", "conversion"))
    assert beef["match"]["canonical_id"] == BEEF.id
    assert ours["ingredients"]["remove"] == ["i9"]
    assert ours["ingredients"]["add"] == [
        {"id": "i10", "after": "i1", "text": "2 can diced tomatoes, drained", "component": None}
    ]
    added = ours["facts"]["ingredients"]["i10"]
    assert all(editors(added[kind]) for kind in ("parse", "match", "conversion"))
    assert added["conversion"]["fdc_id"] == 1002
    assert ours["steps"]["edit"] == {
        "s2": {"text": "Brown the beef in two batches.", "component": None}
    }
    assert ours["note"] == "Less beef, more tomato."
    assert ours["edited_at"]
    assert body["our_version_status"] == "pending"
    assert body["status"] == "ready"
    assert stored(api_store, recipe.id).model_dump(mode="json") == body


def test_our_version_leaves_the_originals_facts_as_they_were(
    editor_client: TestClient, api_store: Store
) -> None:
    facts = FACTS.model_copy(deep=True)
    facts.ingredients["i9"] = IngredientFacts(parse=parse("parsley", **CONFIRMED))
    recipe = ready(api_store, facts)

    response = save(
        editor_client,
        recipe,
        {"ingredients": lines(edit={"i1": line(), "i9": line(name="parsley", fdc_id=None)})},
    )

    assert response.status_code == 200, response.text
    saved = stored(api_store, recipe.id)
    assert saved.facts.model_dump_json() == recipe.facts.model_dump_json()
    assert saved.original == recipe.original
    assert saved.our_version is not None
    parsley = saved.our_version.facts.ingredients["i9"].parse
    assert parsley is not None
    assert parsley.name == "parsley"


def test_a_stale_version_is_a_conflict_that_changes_nothing(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = ready(api_store)

    response = save(
        editor_client, recipe, {"ingredients": lines(edit={"i1": line()})}, recipe.version - 1
    )

    assert response.status_code == 409
    assert stored(api_store, recipe.id) == recipe


def test_a_pending_recipe_has_no_our_version_yet(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = api_store.add_recipe(STEW)

    response = save(editor_client, recipe, {"steps": lines(edit={"s1": {"text": "Brown it."}})})

    assert response.status_code == 409
    assert response.json()["detail"] == "A Pending recipe has no Our Version until it's enriched"
    assert stored(api_store, recipe.id) == recipe


# A line's wording


@pytest.mark.parametrize("choice", ["new", "existing"])
def test_a_canonical_ingredient_chosen_in_our_version_fixes_the_wording_for_the_collection(
    editor_client: TestClient, api_store: Store, choice: str
) -> None:
    recipe = awaiting(api_store, issues=[], status="ready", canonicals=(BEEF, PORK))
    sharing = other(api_store, 2, drained_tomatoes())
    canonical = NEW_TOMATOES if choice == "new" else {"kind": "existing", "id": PORK.id}

    response = save(
        editor_client, recipe, {"ingredients": lines(add=[tomatoes(canonical=canonical)])}
    )

    assert response.status_code == 200, response.text
    added = response.json()["our_version"]["facts"]["ingredients"]["i10"]
    canonical_id = added["match"]["canonical_id"]
    if choice == "existing":
        assert canonical_id == PORK.id
    wording = api_store.wording("diced tomatoes")
    assert wording is not None
    assert (wording.canonical_id, wording.confirmed) == (canonical_id, True)
    shared = stored(api_store, sharing.id).facts.ingredients["i1"]
    assert shared.match is not None
    assert (shared.match.canonical_id, shared.match.fdc_id) == (canonical_id, 1002)


def test_resaving_an_unchanged_line_keeps_its_facts_and_reaches_no_other_recipe(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = ready(api_store)
    first = save(editor_client, recipe, {"ingredients": lines(add=[tomatoes()])}).json()
    added = first["our_version"]["facts"]["ingredients"]["i10"]
    sharing = other(api_store, 2, drained_tomatoes())
    again = tomatoes(id="i10", canonical={"kind": "existing", "id": added["match"]["canonical_id"]})

    response = save(
        editor_client,
        stored(api_store, recipe.id),
        {"ingredients": lines(add=[again]), "note": "Again"},
    )

    assert response.status_code == 200, response.text
    ours = response.json()["our_version"]
    assert ours["facts"]["ingredients"]["i10"] == added
    assert ours["ingredients"] == first["our_version"]["ingredients"]
    assert stored(api_store, sharing.id) == sharing


@pytest.mark.parametrize(
    ("our_version", "detail"),
    [
        ({"ingredients": lines(edit={"i99": line()})}, "The recipe has no line i99"),
        ({"ingredients": lines(remove=["i99"])}, "The recipe has no line i99"),
        ({"steps": lines(edit={"s99": {"text": "Stir."}})}, "The recipe has no step s99"),
        (
            {"ingredients": lines(edit={"i1": line()}, remove=["i1"])},
            "Line i1 is both edited and removed",
        ),
        (
            {"ingredients": lines(remove=["i1"], add=[tomatoes()])},
            "Line i10 follows i1, which isn't in Our Version",
        ),
        (
            {"steps": lines(add=[{"text": "Rest.", "after": "s9"}])},
            "Step s5 follows s9, which isn't in Our Version",
        ),
        (
            {"ingredients": lines(add=[tomatoes(id="x"), tomatoes(id="x", after="x")])},
            "Line x is added twice",
        ),
        (
            {"ingredients": lines(add=[tomatoes(id="i2")])},
            "Line i2 is the Original's, so it can't be added",
        ),
        (
            {"ingredients": lines(edit={"i1": line(name="beef chuck")})},
            "Changing the wording needs a Canonical Ingredient choice",
        ),
        (
            {"ingredients": lines(add=[tomatoes(canonical=None)])},
            "Line i10 needs a Canonical Ingredient choice",
        ),
    ],
    ids=[
        "edit unknown line",
        "remove unknown line",
        "edit unknown step",
        "edit and remove",
        "after removed",
        "after unknown",
        "duplicate id",
        "original id",
        "renamed without canonical",
        "added without canonical",
    ],
)
def test_an_our_version_it_cant_take_is_refused(
    editor_client: TestClient, api_store: Store, our_version: dict[str, Any], detail: str
) -> None:
    recipe = ready(api_store)

    response = save(editor_client, recipe, our_version)

    assert response.status_code == 422
    assert response.json()["detail"] == detail
    assert stored(api_store, recipe.id) == recipe


# Ids


def test_added_lines_and_steps_continue_the_ids_and_keep_them_across_saves(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = ready(api_store)
    beef = line(canonical={"kind": "existing", "id": BEEF.id})

    first = save(
        editor_client,
        recipe,
        {
            "ingredients": lines(add=[tomatoes(id="new"), beef | {"after": "new"}]),
            "steps": lines(add=[{"text": "Rest.", "after": None}]),
        },
    )

    assert first.status_code == 200, first.text
    added = first.json()["our_version"]["ingredients"]["add"]
    assert [(a["id"], a["after"]) for a in added] == [("i10", "i1"), ("i11", "i10")]
    assert first.json()["our_version"]["steps"]["add"][0]["id"] == "s5"

    second = save(
        editor_client,
        stored(api_store, recipe.id),
        {"ingredients": lines(add=[line(id="i11", after="i1"), beef | {"after": "i11"}])},
    )

    assert second.status_code == 200, second.text
    again = second.json()["our_version"]["ingredients"]["add"]
    assert [(a["id"], a["after"]) for a in again] == [("i11", "i1"), ("i12", "i11")]


# Our Version Status


def test_our_version_status_follows_its_step_edits(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = ready(api_store)
    step = {"s2": {"text": "Brown the beef."}}

    def saved(our_version: dict[str, Any]) -> dict[str, Any]:
        response = save(editor_client, stored(api_store, recipe.id), our_version)
        assert response.status_code == 200, response.text
        return response.json()

    assert saved({"ingredients": lines(edit={"i1": line()})})["our_version_status"] == "ready"
    assert saved({"steps": lines(edit=step)})["our_version_status"] == "pending"
    api_store.update_recipe(
        stored(api_store, recipe.id).model_copy(update={"our_version_status": "ready"})
    )
    changed_line = {"ingredients": lines(edit={"i1": line(unit="kg")}), "steps": lines(edit=step)}
    assert saved(changed_line)["our_version_status"] == "ready"
    added = {"steps": lines(edit=step, add=[{"text": "Rest.", "after": "s4"}])}
    after = saved(added)
    assert after["our_version_status"] == "pending"
    assert after["status"] == "ready"
    assert card(api_store, recipe.id)["our_version_status"] == "pending"


def test_removing_our_version_clears_it_and_its_status(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = ready(api_store)
    save(editor_client, recipe, {"steps": lines(edit={"s2": {"text": "Brown the beef."}})})

    response = remove(editor_client, stored(api_store, recipe.id))

    assert response.status_code == 200, response.text
    assert (response.json()["our_version"], response.json()["our_version_status"]) == (None, None)
    assert card(api_store, recipe.id)["our_version_status"] is None
    assert stored(api_store, recipe.id).facts == recipe.facts


def test_a_card_without_our_version_has_no_our_version_status(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = ready(api_store)

    assert card(api_store, recipe.id)["our_version_status"] is None


# A line's text


@pytest.mark.parametrize(
    ("value", "shown"),
    [
        (2, "2"),
        (0.75, "¾"),
        (1.5, "1½"),
        (0.333, "⅓"),
        (2.125, "2⅛"),
        (1.1, "1.1"),
        (0.05, "0.05"),
        (2.996, "3"),
        (450, "450"),
    ],
)
def test_a_quantity_reads_as_the_pwa_shows_it(value: float, shown: str) -> None:
    assert kitchen_number(value) == shown


def parsed(quantity: Quantity | None, unit: str | None, name: str, **fields: Any) -> ParseFact:
    return parse(name).model_copy(
        update={"quantity": quantity, "unit": unit, "preparation": None, **fields}
    )


@pytest.mark.parametrize(
    ("parse", "text"),
    [
        (
            parsed(Quantity(low=2, high=2), "can", "diced tomatoes", preparation="drained"),
            "2 can diced tomatoes, drained",
        ),
        (
            parsed(Quantity(low=0.75, high=0.75), "cup", "onion", preparation="chopped"),
            "¾ cup onion, chopped",
        ),
        (parsed(Quantity(low=2, high=3), "cup", "stock"), "2\N{EN DASH}3 cups stock"),
        (parsed(Quantity(low=3, high=3), None, "eggs"), "3 eggs"),
        (parsed(None, None, "salt", comment="to taste"), "salt, to taste"),
    ],
)
def test_a_lines_text_is_built_from_its_parse(parse: ParseFact, text: str) -> None:
    assert line_text(parse) == text


def test_another_recipes_line_is_matched_with_the_snapshots_numbers(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = ready(api_store)
    sharing = other(api_store, 2, drained_tomatoes())

    assert save(editor_client, recipe, {"ingredients": lines(add=[tomatoes()])}).status_code == 200

    conversion = stored(api_store, sharing.id).facts.ingredients["i1"].conversion
    assert conversion is not None
    found = conversion.model_dump(mode="json")
    assert {key: found[key] for key in numbers(1002, 503)} == numbers(1002, 503)


def test_the_seeds_roast_chicken_has_an_our_version_waiting_for_enrich(
    store: Store, images: ImageStore
) -> None:
    load(store, images)

    chicken = stored(store, CHICKEN_ID)
    assert chicken.our_version is not None
    assert (chicken.status, chicken.our_version_status) == ("ready", "pending")
    assert card(store, CHICKEN_ID)["our_version_status"] == "pending"
    ours = chicken.our_version
    written = {**ours.ingredients.edit, **{line.id: line for line in ours.ingredients.add}}
    assert written.keys() == ours.facts.ingredients.keys()
    for line_id, line in written.items():
        parse = ours.facts.ingredients[line_id].parse
        assert parse is not None
        assert line.text == line_text(parse)
    wording = store.wording("garlic cloves")
    assert wording is not None
    assert (wording.canonical_id, wording.confirmed) == (GARLIC.id, True)
