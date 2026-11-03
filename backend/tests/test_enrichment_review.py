"""An editor reviews a recipe's enrichment: confirming facts in batches, accepting corrections,
and undoing a batch, which may move the recipe between Awaiting Review and Ready.
"""

import json
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

import pytest
from conftest import EDITOR, SERVICE_TOKEN

from recipes.auth import Editor, current_editor
from recipes.models import (
    SCHEMA_VERSION,
    CanonicalIngredient,
    ConversionFact,
    Difficulty,
    DifficultyFact,
    EnrichmentIssue,
    IngredientFacts,
    MatchFact,
    ParseFact,
    Quantity,
    Recipe,
    RecipeFacts,
    SegmentsFact,
    StepFacts,
    SubstitutionsFact,
    TextSegment,
    UsesFact,
    Wording,
    card_for,
    needs_review,
    review_items,
)
from recipes.seed import BUTTER, RECIPES, REVIEW_RECIPE_ID, load

if TYPE_CHECKING:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from httpx2 import Response

    from recipes.images import ImageStore
    from recipes.store import Store

# The seed's Pending beef stew, whose lines are i1 to i9 and steps s1 to s4.
STEW = next(recipe for recipe in RECIPES if recipe.status == "pending")
SECOND_ID = "01K7Q0000000000000000000E1"
UNKNOWN_BATCH = "01K7Q0000000000000000000ZZ"
GOOGLE_EDITOR = "editor@example.com"

BEEF = CanonicalIngredient(
    id="01K7Q0000000000000000000C1",
    name="stewing beef",
    family="beef",
    store_category_id="meat",
    version=1,
    schema_version=SCHEMA_VERSION,
)
LLM = {"provenance": "llm", "confidence": 0.8, "estimated": False}
FDC = {
    "provenance": "fdc",
    "confidence": 0.8,
    "estimated": True,
    "dataset": "sr_legacy",
    "release": "foundation-2026-04-01+sr_legacy-2018-04",
    "density_g_per_ml": None,
    "grams_per_count": None,
    "count_unit": None,
    "refused": "The line is already a weight",
    "per_100g": {"kcal": 150, "protein_g": 20, "fat_g": 7, "carbs_g": 0, "sodium_mg": None},
}
SWAP = {
    "wording": "beef chuck",
    "canonical_id": BEEF.id,
    "ratio": 1,
    "note": "simmer a little longer",
    "fdc_id": 1002,
    "portion_id": None,
    "fdc": {k: v for k, v in FDC.items() if k not in {"provenance", "confidence", "estimated"}},
}


def parse(name: str, **fields: Any) -> ParseFact:
    return ParseFact(
        provenance="parser",
        confidence=0.9,
        estimated=False,
        quantity=Quantity(low=1, high=1),
        unit=None,
        unit_kind="count",
        name=name,
        preparation=None,
        **fields,
    )


def match(canonical_id: str = BEEF.id, **fields: Any) -> MatchFact:
    return MatchFact.model_validate(
        {**LLM, "canonical_id": canonical_id, "fdc_id": 1001, "portion_id": None, **fields}
    )


def conversion(**fields: Any) -> ConversionFact:
    return ConversionFact.model_validate({**FDC, "fdc_id": 1001, **fields})


def uses(**fields: Any) -> UsesFact:
    return UsesFact.model_validate({**LLM, "uses": [], **fields})


def suggestion(**fields: Any) -> DifficultyFact:
    return DifficultyFact.model_validate(
        {"provenance": "llm", "confidence": 0.6, "estimated": True, "prep": 2, "cook": 3}
        | {"cleanup": 1, **fields}
    )


def issue(n: int, fact_id: str = "i1.match", **fields: Any) -> EnrichmentIssue:
    return EnrichmentIssue.model_validate(
        {
            "id": f"01K7Q0000000000000000000D{n}",
            "fact_id": fact_id,
            "before": "beef chuck",
            "after": "stewing beef",
            "reason": "The line says stewing beef",
            **fields,
        }
    )


CONFIRMED = {
    "confirmed": True,
    "confirmed_by": "editor",
    "confirmed_at": "2026-10-01T12:00:00Z",
    "confirm_batch": "01K7Q0000000000000000000B1",
}


# Four review items: the beef line (i1), the parsley line (i9), the first step and the Difficulty.
FACTS = RecipeFacts(
    ingredients={
        "i1": IngredientFacts(parse=parse("stewing beef"), match=match(), conversion=conversion()),
        "i9": IngredientFacts(parse=parse("parsley")),
    },
    steps={"s1": StepFacts(uses=uses())},
    difficulty=suggestion(),
)
ISSUES = [issue(1)]


def awaiting(
    store: Store,
    facts: RecipeFacts = FACTS,
    issues: list[EnrichmentIssue] = ISSUES,
    canonicals: tuple[CanonicalIngredient, ...] = (BEEF,),
    **fields: object,
) -> Recipe:
    """The stew as enrichment leaves it: Awaiting Review, with BEEF new and unconfirmed."""
    added = store.add_recipe(STEW.model_copy(update=fields))
    enriched = added.model_copy(
        update={
            "facts": facts,
            "issues": issues,
            "status": "awaiting_review",
            "ingest_channel": "add_a_recipe",
            **fields,
        }
    )
    wording = Wording(wording="stewing beef", canonical_id=BEEF.id, schema_version=SCHEMA_VERSION)
    return store.enrich_recipe(enriched, canonicals, [wording] if canonicals else [])


def confirm(
    client: TestClient, recipe: Recipe, *fact_ids: str, version: int | None = None
) -> Response:
    body = {"version": recipe.version if version is None else version, "fact_ids": list(fact_ids)}
    return client.post(f"/api/recipes/{recipe.id}/confirm", json=body, headers=EDITOR)


def undo(client: TestClient, recipe_id: str, batch: str) -> Response:
    return client.post(
        f"/api/recipes/{recipe_id}/confirm-batches/{batch}/undo", json={}, headers=EDITOR
    )


def stored(store: Store, recipe_id: str) -> Recipe:
    recipe = store.get_recipe(recipe_id)
    assert recipe is not None
    return recipe


def canonical(store: Store, canonical_id: str = BEEF.id) -> CanonicalIngredient:
    return next(c for c in store.canonical_ingredients() if c.id == canonical_id)


def fact(recipe: Recipe, path: str) -> dict[str, Any]:
    facts = recipe.facts.model_dump(mode="json")
    if path == "difficulty":
        return facts["difficulty"]
    owner, kind = path.split(".")
    return (facts["ingredients"] | facts["steps"])[owner][kind]


def card(store: Store, recipe_id: str) -> dict[str, Any]:
    found = next(card for card in store.cards() if card.id == recipe_id)
    return found.model_dump(mode="json")


# Review items


def test_review_items_group_a_recipes_facts_as_an_editor_checks_them() -> None:
    facts = FACTS.model_copy(
        update={
            "ingredients": {
                **FACTS.ingredients,
                "i2": IngredientFacts(
                    parse=parse("flour"),
                    substitutions=SubstitutionsFact.model_validate(
                        {**LLM, "estimated": True, "items": [SWAP]}
                    ),
                ),
            },
            "steps": {
                **FACTS.steps,
                "s2": StepFacts(
                    segments=SegmentsFact.model_validate(
                        {**LLM, "segments": [TextSegment(v="Add the onion and cook until soft.")]}
                    ),
                    uses=uses(),
                ),
            },
        }
    )

    assert review_items(STEW.model_copy(update={"facts": facts})) == {
        "i1": ["i1.parse", "i1.match", "i1.conversion"],
        "i9": ["i9.parse"],
        "i2": ["i2.parse"],
        "i2.substitutions": ["i2.substitutions"],
        "s1": ["s1.uses"],
        "s2": ["s2.segments", "s2.uses"],
        "difficulty": ["difficulty"],
    }


# Cases the PWA's review.test.tsx checks too, so the two groupings can't drift apart.
SHARED = json.loads((Path(__file__).parent / "fixtures" / "review_items.json").read_text())


# One unconfirmed fact of each kind, to build a shared case's facts from.
ONE_OF_EACH = {
    "parse": parse("flour"),
    "match": match(),
    "conversion": conversion(),
    "substitutions": SubstitutionsFact.model_validate({**LLM, "estimated": True, "items": [SWAP]}),
    "segments": SegmentsFact.model_validate({**LLM, "segments": [TextSegment(v="Stir.")]}),
    "uses": uses(),
    "difficulty": suggestion(),
}


def shared_recipe(case: dict[str, Any]) -> Recipe:
    facts: dict[str, Any] = {"ingredients": {}, "steps": {}}
    for path, confirmed in case["facts"].items():
        owner, _, kind = path.rpartition(".")
        made = ONE_OF_EACH[kind].model_dump() | (CONFIRMED if confirmed else {})
        if not owner:
            facts[kind] = made
        else:
            facts["ingredients" if owner[0] == "i" else "steps"].setdefault(owner, {})[kind] = made
    editors = Difficulty(prep=1, cook=1, cleanup=1) if case["editor_difficulty"] else None
    return STEW.model_copy(
        update={
            "facts": RecipeFacts.model_validate(facts),
            "issues": [issue(n, fact_id) for n, fact_id in enumerate(case["open_issues"])],
            "difficulty": editors,
        }
    )


@pytest.mark.parametrize("case", SHARED["cases"], ids=[c["name"] for c in SHARED["cases"]])
def test_review_items_are_the_shared_cases(case: dict[str, Any]) -> None:
    recipe = shared_recipe(case)

    assert review_items(recipe) == case["items"]
    assert needs_review(recipe).unconfirmed == case["unconfirmed"]


def test_an_open_issue_on_a_fact_the_recipe_lacks_is_a_review_item_of_its_line() -> None:
    issues = [
        issue(1),
        issue(2, "i9.match"),
        issue(3, "i5.match"),
        issue(4, "i5.parse", status="resolved"),
        issue(5, "difficulty"),
    ]
    recipe = STEW.model_copy(
        update={
            "facts": FACTS,
            "issues": issues,
            "difficulty": Difficulty(prep=1, cook=1, cleanup=1),
        }
    )

    items = review_items(recipe)

    assert items["i1"] == ["i1.parse", "i1.match", "i1.conversion"]
    assert items["i9"] == ["i9.parse", "i9.match"]
    assert items["i5"] == ["i5.match"]
    assert items["difficulty"] == ["difficulty"]


def test_the_card_counts_unconfirmed_review_items_not_facts() -> None:
    # i1 is unconfirmed while any of its facts is; i9 is all confirmed; s1 has empty uses and no
    # segments; the issue on a fact the recipe lacks is open, and its item has nothing unconfirmed.
    facts = FACTS.model_copy(
        update={
            "ingredients": {
                "i1": IngredientFacts(
                    parse=parse("stewing beef", **CONFIRMED),
                    match=match(),
                    conversion=conversion(**CONFIRMED),
                ),
                "i9": IngredientFacts(parse=parse("parsley", **CONFIRMED)),
            }
        }
    )
    recipe = STEW.model_copy(update={"facts": facts, "issues": [issue(1, "i5.match")]})

    assert card_for(recipe).needs_review.model_dump() == {"open_issues": 1, "unconfirmed": 3}


def test_the_editors_own_difficulty_leaves_the_suggestion_out_of_review() -> None:
    recipe = STEW.model_copy(
        update={"facts": FACTS, "difficulty": Difficulty(prep=1, cook=1, cleanup=1)}
    )

    assert "difficulty" not in review_items(recipe)
    assert card_for(recipe).needs_review.unconfirmed == 3


def test_a_confirmed_suggested_difficulty_is_the_recipes_difficulty() -> None:
    confirmed = STEW.model_copy(update={"facts": RecipeFacts(difficulty=suggestion(**CONFIRMED))})
    editors = Difficulty(prep=1, cook=1, cleanup=1)

    assert (card_for(confirmed).difficulty, card_for(confirmed).difficulty_suggested) == (
        Difficulty(prep=2, cook=3, cleanup=1),
        False,
    )
    overruled = card_for(confirmed.model_copy(update={"difficulty": editors}))
    assert (overruled.difficulty, overruled.difficulty_suggested) == (editors, False)


# Confirming


def test_confirming_stamps_one_batch_on_the_facts_issues_and_canonical_ingredient(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store)

    response = confirm(editor_client, recipe, "i1.parse", "i1.match", "i1.conversion")

    assert response.status_code == 200
    body = response.json()
    batch = body["confirm_batch"]
    assert body["ready"] is False
    after = stored(api_store, recipe.id)
    assert body["recipe"] == after.model_dump(mode="json")
    assert after.version == recipe.version + 1
    for path in ("i1.parse", "i1.match", "i1.conversion"):
        assert fact(after, path)["confirmed"] is True
        assert fact(after, path)["confirmed_by"] == "editor"
        assert fact(after, path)["confirmed_at"] is not None
        assert fact(after, path)["confirm_batch"] == batch
    assert fact(after, "i9.parse")["confirmed"] is False
    assert [(i.status, i.confirm_batch) for i in after.issues] == [("resolved", batch)]
    beef = canonical(api_store)
    assert (beef.confirmed, beef.confirm_batch, beef.version) == (True, batch, 2)
    assert api_store.wordings() == [
        Wording(
            wording="stewing beef",
            canonical_id=BEEF.id,
            confirmed=True,
            schema_version=SCHEMA_VERSION,
        )
    ]
    assert card(api_store, recipe.id)["needs_review"] == {"open_issues": 0, "unconfirmed": 3}


def test_a_confirmed_recipe_served_to_anyone_names_no_editor(
    editor_client: TestClient, api_store: Store
) -> None:
    # A Google sign-in's editor is named by their email, which must never reach a public recipe.
    app = cast("FastAPI", editor_client.app)
    signed_in = Editor(name=GOOGLE_EDITOR, email=GOOGLE_EDITOR)
    app.dependency_overrides[current_editor] = lambda: signed_in
    recipe = awaiting(api_store)

    confirm(editor_client, recipe, "i1.parse", "i1.match", "i1.conversion")

    after = stored(api_store, recipe.id)
    served = editor_client.get(f"/api/v/recipes/{recipe.id}/{after.version}/{SCHEMA_VERSION}")
    assert served.status_code == 200
    assert "@" not in served.text
    assert fact(after, "i1.parse")["confirmed_by"] == "editor"


def test_accepting_a_correction_resolves_an_issue_on_a_fact_the_recipe_lacks(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store, issues=[issue(1, "i5.match")])

    response = confirm(editor_client, recipe, "i5.match")

    assert response.status_code == 200
    assert stored(api_store, recipe.id).issues[0].status == "resolved"


def test_confirming_a_stale_version_is_a_conflict(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store)

    response = confirm(editor_client, recipe, "i9.parse", version=recipe.version - 1)

    assert response.status_code == 409
    assert stored(api_store, recipe.id) == recipe


@pytest.mark.parametrize(
    "fact_ids",
    [["i9.parse", "i2.parse"], ["i9.nonsense"], ["s9.uses"], ["i9.__class__"], []],
    ids=["unknown line", "unknown kind", "unknown step", "not a field", "none"],
)
def test_confirming_an_unknown_fact_is_refused(
    editor_client: TestClient, api_store: Store, fact_ids: list[str]
) -> None:
    recipe = awaiting(api_store)

    response = confirm(editor_client, recipe, *fact_ids)

    assert response.status_code == 422
    assert stored(api_store, recipe.id) == recipe


def test_confirming_only_confirmed_facts_is_refused(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store)
    batch = confirm(editor_client, recipe, "i9.parse").json()["confirm_batch"]
    again = stored(api_store, recipe.id)

    response = confirm(editor_client, again, "i9.parse")

    assert response.status_code == 422
    assert fact(stored(api_store, recipe.id), "i9.parse")["confirm_batch"] == batch


def test_a_fact_already_confirmed_keeps_its_batch(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store)
    first = confirm(editor_client, recipe, "i9.parse").json()

    second = confirm(editor_client, stored(api_store, recipe.id), "i9.parse", "difficulty").json()

    after = stored(api_store, recipe.id)
    assert fact(after, "i9.parse")["confirm_batch"] == first["confirm_batch"]
    assert fact(after, "difficulty")["confirm_batch"] == second["confirm_batch"]


def test_only_an_editor_can_confirm_or_undo(client: TestClient, api_store: Store) -> None:
    recipe = awaiting(api_store)
    body = {"version": recipe.version, "fact_ids": ["i9.parse"]}

    confirmed = client.post(f"/api/recipes/{recipe.id}/confirm", json=body)
    undone = client.post(f"/api/recipes/{recipe.id}/confirm-batches/{UNKNOWN_BATCH}/undo")
    with_a_wrong_token = client.post(
        f"/api/recipes/{recipe.id}/confirm",
        json=body,
        headers={next(iter(EDITOR)): SERVICE_TOKEN + "x"},
    )

    assert (confirmed.status_code, undone.status_code) == (403, 403)
    assert with_a_wrong_token.status_code in {401, 403}
    assert stored(api_store, recipe.id) == recipe


def test_confirming_an_unknown_recipe_is_not_found(editor_client: TestClient) -> None:
    response = confirm(editor_client, STEW.model_copy(update={"id": SECOND_ID}), "i1.parse")

    assert response.status_code == 404


# Ready


def test_the_last_confirm_moves_an_awaiting_review_recipe_to_ready(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store)
    first = confirm(editor_client, recipe, "i1.parse", "i1.match", "i1.conversion", "i9.parse")
    assert (first.json()["ready"], first.json()["recipe"]["status"]) == (False, "awaiting_review")

    last = confirm(editor_client, stored(api_store, recipe.id), "s1.uses", "difficulty").json()

    assert last["ready"] is True
    assert last["recipe"]["status"] == "ready"
    assert last["recipe"]["ready_batch"] == last["confirm_batch"]
    assert card(api_store, recipe.id)["status"] == "ready"
    assert card(api_store, recipe.id)["needs_review"] == {"open_issues": 0, "unconfirmed": 0}


def test_an_open_issue_keeps_a_recipe_awaiting_review(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store, issues=[issue(1, "i5.match")])

    every_fact = ["i1.parse", "i1.match", "i1.conversion", "i9.parse", "s1.uses", "difficulty"]
    response = confirm(editor_client, recipe, *every_fact)

    assert (response.json()["ready"], response.json()["recipe"]["status"]) == (
        False,
        "awaiting_review",
    )


def test_a_recipe_with_the_editors_difficulty_is_ready_without_confirming_the_suggestion(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store, difficulty=Difficulty(prep=1, cook=1, cleanup=1))

    every_line_and_step = ["i1.parse", "i1.match", "i1.conversion", "i9.parse", "s1.uses"]
    response = confirm(editor_client, recipe, *every_line_and_step)

    assert response.json()["ready"] is True


def test_setting_the_editors_difficulty_on_the_last_item_left_makes_the_recipe_ready(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store)
    every_line_and_step = ["i1.parse", "i1.match", "i1.conversion", "i9.parse", "s1.uses"]
    batch = confirm(editor_client, recipe, *every_line_and_step).json()["confirm_batch"]
    own = {"op": "set_difficulty", "difficulty": {"prep": 1, "cook": 1, "cleanup": 1}}
    body = {"version": stored(api_store, recipe.id).version, "operations": [own]}

    response = editor_client.patch(f"/api/recipes/{recipe.id}", json=body, headers=EDITOR)

    assert response.status_code == 200
    assert (response.json()["status"], response.json()["ready_batch"]) == ("ready", None)
    assert card(api_store, recipe.id)["status"] == "ready"
    assert undo(editor_client, recipe.id, batch).json()["status"] == "ready"


def test_undo_unconfirms_a_suggestion_the_editors_difficulty_overrode_since(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store)
    batch = confirm(editor_client, recipe, "difficulty").json()["confirm_batch"]
    overrode = api_store.update_recipe(
        stored(api_store, recipe.id).model_copy(
            update={"difficulty": Difficulty(prep=1, cook=1, cleanup=1)}
        )
    )

    response = undo(editor_client, overrode.id, batch)

    assert response.status_code == 200
    assert fact(stored(api_store, recipe.id), "difficulty")["confirmed"] is False


def test_undoing_the_batch_that_made_a_recipe_ready_moves_it_back(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store)
    confirm(editor_client, recipe, "i1.parse", "i1.match", "i1.conversion", "i9.parse")
    last = confirm(editor_client, stored(api_store, recipe.id), "s1.uses", "difficulty").json()

    response = undo(editor_client, recipe.id, last["confirm_batch"])

    assert response.status_code == 200
    assert response.json()["status"] == "awaiting_review"
    assert response.json()["ready_batch"] is None
    assert card(api_store, recipe.id)["status"] == "awaiting_review"
    assert card(api_store, recipe.id)["needs_review"] == {"open_issues": 0, "unconfirmed": 2}


def test_undo_leaves_a_ready_bulk_import_recipe_ready(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store)
    bulk = api_store.update_recipe(
        recipe.model_copy(update={"status": "ready", "ingest_channel": "bulk_import"})
    )
    every_fact = ["i1.parse", "i1.match", "i1.conversion", "i9.parse", "s1.uses", "difficulty"]
    batch = confirm(editor_client, bulk, *every_fact).json()["confirm_batch"]

    response = undo(editor_client, recipe.id, batch)

    assert response.json()["status"] == "ready"


# Undo


def test_undo_reverses_exactly_its_batch(editor_client: TestClient, api_store: Store) -> None:
    recipe = awaiting(api_store)
    first = confirm(editor_client, recipe, "i1.parse", "i1.match").json()["confirm_batch"]
    later = confirm(editor_client, stored(api_store, recipe.id), "i9.parse").json()

    response = undo(editor_client, recipe.id, first)

    assert response.status_code == 200
    after = stored(api_store, recipe.id)
    assert after.version == later["recipe"]["version"] + 1
    for path in ("i1.parse", "i1.match"):
        assert {k: fact(after, path)[k] for k in CONFIRMED} == dict.fromkeys(CONFIRMED) | {
            "confirmed": False
        }
    assert fact(after, "i9.parse")["confirm_batch"] == later["confirm_batch"]
    assert [(i.status, i.confirm_batch) for i in after.issues] == [("open", None)]
    beef = canonical(api_store)
    assert (beef.confirmed, beef.confirm_batch) == (False, None)
    assert api_store.wordings()[0].confirmed is True


def test_undo_reverts_a_canonical_ingredient_only_while_its_batch_is_on_it(
    editor_client: TestClient, api_store: Store
) -> None:
    first = awaiting(api_store)
    second = awaiting(
        api_store, canonicals=(), id=SECOND_ID, dedupe_key="https://plateful.test/second"
    )
    stamped = confirm(editor_client, first, "i1.match").json()["confirm_batch"]
    unstamped = confirm(editor_client, second, "i1.match").json()["confirm_batch"]

    undo(editor_client, second.id, unstamped)
    assert (canonical(api_store).confirmed, canonical(api_store).confirm_batch) == (True, stamped)

    undo(editor_client, first.id, stamped)
    assert (canonical(api_store).confirmed, canonical(api_store).confirm_batch) == (False, None)


def test_undoing_an_unknown_batch_is_not_found(editor_client: TestClient, api_store: Store) -> None:
    recipe = awaiting(api_store)

    response = undo(editor_client, recipe.id, UNKNOWN_BATCH)

    assert response.status_code == 404
    assert stored(api_store, recipe.id) == recipe


def test_undoing_twice_is_not_found(editor_client: TestClient, api_store: Store) -> None:
    recipe = awaiting(api_store)
    batch = confirm(editor_client, recipe, "i9.parse").json()["confirm_batch"]
    undo(editor_client, recipe.id, batch)

    assert undo(editor_client, recipe.id, batch).status_code == 404


def test_confirming_the_suggested_difficulty_makes_it_the_cards_difficulty_until_undone(
    editor_client: TestClient, api_store: Store
) -> None:
    recipe = awaiting(api_store)

    batch = confirm(editor_client, recipe, "difficulty").json()["confirm_batch"]

    shown = card(api_store, recipe.id)
    assert (shown["difficulty"], shown["difficulty_suggested"]) == (
        {"prep": 2, "cook": 3, "cleanup": 1},
        False,
    )
    assert stored(api_store, recipe.id).difficulty is None
    undo(editor_client, recipe.id, batch)
    assert card(api_store, recipe.id)["difficulty_suggested"] is True


def test_the_seed_has_a_recipe_awaiting_review_with_something_flagged(
    store: Store, images: ImageStore
) -> None:
    load(store, images)

    recipe = stored(store, REVIEW_RECIPE_ID)
    assert recipe.status == "awaiting_review"
    assert fact(recipe, "i2.match")["canonical_id"] == BUTTER.id
    assert fact(recipe, "i2.conversion")["density_g_per_ml"] is not None
    assert [(i.fact_id, i.status) for i in recipe.issues] == [("i2.match", "open")]
    assert canonical(store, BUTTER.id).confirmed is False
    assert card(store, REVIEW_RECIPE_ID)["needs_review"] == {"open_issues": 1, "unconfirmed": 4}
