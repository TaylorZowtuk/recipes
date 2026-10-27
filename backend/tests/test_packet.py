"""The work packet: what enrichment offers a model for each line, and how its answer is checked
against those offers before anything is written.
"""

from pathlib import Path
from typing import Any

import pytest

from recipes import fdc
from recipes.models import (
    SCHEMA_VERSION,
    CanonicalIngredient,
    IngredientLine,
    Original,
    Recipe,
    StoreCategory,
    WebsiteSource,
    Wording,
)
from recipes.packet import Answer, Rejected, Work, readable_quantities
from recipes.parse import parse_line

FIXTURE = Path(__file__).parent / "fixtures" / "fdc-snapshot.json"
SNAPSHOT = fdc.load_snapshot(FIXTURE)
CATEGORIES = [StoreCategory(id="aisles", name="Aisles"), StoreCategory(id="dairy", name="Dairy")]
RECIPE_ID = "01K7Q0000000000000000000R1"
GLIMMER_ID = "01K7Q0000000000000000000C1"
GLIMMER = CanonicalIngredient(
    id=GLIMMER_ID,
    name="glimmer oil",
    family="oil",
    store_category_id="aisles",
    version=1,
    schema_version=SCHEMA_VERSION,
)
LINES = ["2 quill eggs", "1-2 tsp glimmer oil", "3 cloves snorp garlic, minced", "salt, to taste"]


def recipe(*lines: str, recipe_id: str = RECIPE_ID) -> Recipe:
    return Recipe(
        id=recipe_id,
        schema_version=SCHEMA_VERSION,
        version=1,
        source=WebsiteSource(
            url=f"https://example.com/{recipe_id}",
            site_name="Example Kitchen",
            captured_at="2026-09-01T12:00:00Z",  # pyright: ignore[reportArgumentType]
        ),
        dedupe_key=f"https://example.com/{recipe_id}",
        original=Original(
            title="Quill Egg Fry",
            extractor="json-ld",
            ingredients=[
                IngredientLine(id=f"i{n}", text=text) for n, text in enumerate(lines or LINES, 1)
            ],
            steps=[],
        ),
        status="pending",
    )


def wording(text: str, canonical_id: str = GLIMMER_ID, *, confirmed: bool = False) -> Wording:
    return Wording(
        wording=text, canonical_id=canonical_id, confirmed=confirmed, schema_version=SCHEMA_VERSION
    )


def canonical(n: int, name: str) -> CanonicalIngredient:
    return GLIMMER.model_copy(update={"id": f"01K7Q000000000000000000{n:03d}", "name": name})


def work(
    *recipes: Recipe,
    canonicals: list[CanonicalIngredient] | None = None,
    wordings: list[Wording] | None = None,
) -> Work:
    return Work(
        recipes=list(recipes) or [recipe()],
        canonical_ingredients=[GLIMMER] if canonicals is None else canonicals,
        wordings=[wording("glimmer oil")] if wordings is None else wordings,
        store_categories=CATEGORIES,
        snapshot=SNAPSHOT,
    )


def line(line_id: str = "i2", **fields: Any) -> dict[str, Any]:
    """An answer for a line, by default glimmer oil's: the offered canonical, food and portion."""
    return {
        "line_id": line_id,
        "canonical": {"id": GLIMMER_ID},
        "fdc_id": 2004,
        "portion_id": 606,
        **fields,
    }


def answer(*lines: dict[str, Any], recipe_id: str = RECIPE_ID) -> Answer:
    return Answer.model_validate(
        {
            "packet_id": "ignored here",
            "model": "a-model",
            "recipes": [{"recipe_id": recipe_id, "lines": list(lines or [line()])}],
        }
    )


def errors(work: Work, answered: Answer) -> list[str]:
    with pytest.raises(Rejected) as rejected:
        work.enrich(answered.recipes[0], answered.model)
    return rejected.value.errors


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("1/2 cup glimmer oil", [0.5]),
        ("1 1/2 cups zorbleberries", [1.5]),
        # The parser reads this one as a range too, and its reading is offered with the rest.
        ("1-1/2 cups zorbleberries", [0.5, 1, 1.5]),
        ("1½ cups zorbleberries", [1.5]),
        ("½ cup glimmer oil", [0.5]),
        ("⅓ cup glimmer oil", [0.3333]),
        ("2.5 kg plonk beans", [2.5]),
        ("1-2 tsp glimmer oil", [1, 2]),
        ("one or two quill eggs", [1, 2]),
        ("twelve quill eggs", [12]),
        ("an quill egg", [1]),
        ("half a zorbleberry", [0.5, 1]),
        ("2 dozen quill eggs", [2, 24]),
        ("1 lb 2 oz plonk beans", [1, 1.125, 2]),
        ("salt, to taste", []),
    ],
)
def test_readable_quantities_are_the_numbers_written_in_the_line(
    text: str, expected: list[float]
) -> None:
    assert readable_quantities(text, parse_line(text)) == expected


def test_the_packet_offers_each_line_its_parse_candidates_and_readable_quantities() -> None:
    packet = work().packet()

    assert packet.fdc_release == SNAPSHOT.release
    assert [(c.id, c.name) for c in packet.store_categories] == [
        ("aisles", "Aisles"),
        ("dairy", "Dairy"),
    ]
    assert packet.families == ["oil"]
    (offered,) = packet.recipes
    assert offered.recipe_id == RECIPE_ID
    assert [ln.line_id for ln in offered.lines] == ["i1", "i2", "i3", "i4"]
    eggs, oil, garlic, salt = offered.lines
    assert eggs.parse is not None
    assert (eggs.parse.name, eggs.readable_quantities) == ("quill eggs", [2])
    assert [food.fdc_id for food in eggs.fdc_candidates] == [1002, 2003, 2008]
    assert eggs.canonical_candidates == []
    assert [(c.id, c.from_wording) for c in oil.canonical_candidates] == [(GLIMMER_ID, True)]
    assert [food.fdc_id for food in oil.fdc_candidates] == [2004]
    assert [p.id for p in oil.fdc_candidates[0].portions] == [606, 607]
    assert [food.fdc_id for food in garlic.fdc_candidates] == [3001, 2007]
    assert salt.readable_quantities == []
    assert packet.instructions


def test_the_packet_id_is_the_same_for_the_same_work_and_changes_with_it() -> None:
    first = work().packet().packet_id

    assert work().packet().packet_id == first
    assert work(canonicals=[GLIMMER, canonical(2, "quill egg")]).packet().packet_id != first


def test_a_cached_wordings_canonical_comes_first_then_canonicals_sharing_a_word() -> None:
    others = [canonical(n, f"glimmer oil {n}") for n in range(2, 12)]
    unrelated = canonical(20, "quill egg")

    packet = work(canonicals=[*others, unrelated, GLIMMER]).packet()

    oil = packet.recipes[0].lines[1]
    assert len(oil.canonical_candidates) == 8
    assert oil.canonical_candidates[0].id == GLIMMER_ID
    assert [c.from_wording for c in oil.canonical_candidates] == [True] + [False] * 7
    assert unrelated.id not in [c.id for c in oil.canonical_candidates]
    assert oil.canonical_candidates[1:] == sorted(
        oil.canonical_candidates[1:], key=lambda c: c.name
    )


def test_a_confirmed_wording_offers_only_its_canonical() -> None:
    others = [canonical(2, "glimmer oil, toasted")]

    packet = work(
        canonicals=[*others, GLIMMER], wordings=[wording("glimmer oil", confirmed=True)]
    ).packet()

    oil = packet.recipes[0].lines[1]
    assert [c.id for c in oil.canonical_candidates] == [GLIMMER_ID]
    assert oil.wording_confirmed


def test_an_answer_within_the_offers_gives_a_match_and_a_conversion_from_the_snapshot() -> None:
    enrichment = work().enrich(answer().recipes[0], "a-model")

    assert enrichment.fdc_release == SNAPSHOT.release
    facts = enrichment.facts.ingredients
    assert sorted(facts) == ["i1", "i2", "i3", "i4"]
    assert all(facts[i].match is None for i in ("i1", "i3", "i4"))
    oil = facts["i2"]
    assert oil.parse is not None
    assert oil.parse.provenance == "parser"
    assert oil.match is not None
    assert (oil.match.provenance, oil.match.canonical_id) == ("llm", GLIMMER_ID)
    assert (oil.match.fdc_id, oil.match.portion_id) == (2004, 606)
    conversion = oil.conversion
    assert conversion is not None
    assert (conversion.provenance, conversion.estimated) == ("fdc", True)
    assert (conversion.dataset, conversion.release) == ("sr_legacy", SNAPSHOT.release)
    assert conversion.density_g_per_ml == pytest.approx(13.5 / 14.78676478125)
    assert conversion.per_100g.model_dump() == SNAPSHOT.food(2004).per_100g.model_dump()
    assert conversion.confidence == oil.parse.confidence
    assert enrichment.issues == []
    assert enrichment.canonical_ingredients == []
    # The wording maps to the same canonical already, so there's nothing to learn.
    assert enrichment.wordings == []


def test_a_new_canonical_ingredient_is_created_learned_and_raised_as_an_issue() -> None:
    new = {"new": {"name": "Quill Egg", "family": "Egg", "store_category_id": "dairy"}}

    enrichment = work().enrich(
        answer(line("i1", canonical=new, fdc_id=1002, portion_id=503)).recipes[0], "a-model"
    )

    (created,) = enrichment.canonical_ingredients
    assert (created.name, created.family, created.store_category_id) == (
        "Quill Egg",
        "egg",
        "dairy",
    )
    assert (created.confirmed, created.version, created.schema_version) == (False, 1, 1)
    match = enrichment.facts.ingredients["i1"].match
    assert match is not None
    assert match.canonical_id == created.id
    conversion = enrichment.facts.ingredients["i1"].conversion
    assert conversion is not None
    assert (conversion.grams_per_count, conversion.count_unit) == (50, "large")
    assert [(w.wording, w.canonical_id, w.confirmed) for w in enrichment.wordings] == [
        ("quill eggs", created.id, False)
    ]
    (issue,) = enrichment.issues
    assert (issue.fact_id, issue.before, issue.after) == ("i1.match", None, "Quill Egg")
    assert issue.reason == "new Canonical Ingredient Quill Egg (egg, Dairy)"
    assert (issue.model, issue.status) == ("a-model", "open")


def test_two_lines_naming_the_same_new_canonical_create_it_once() -> None:
    new = {"new": {"name": "quill egg", "family": "egg", "store_category_id": "dairy"}}
    twice = recipe("2 quill eggs", "1 quill egg yolk")

    enrichment = work(twice).enrich(
        answer(
            line("i1", canonical=new, fdc_id=1002, portion_id=503),
            line("i2", canonical=new, fdc_id=1002, portion_id=None),
        ).recipes[0],
        "a-model",
    )

    (created,) = enrichment.canonical_ingredients
    matches = [enrichment.facts.ingredients[i].match for i in ("i1", "i2")]
    assert [m.canonical_id for m in matches if m] == [created.id, created.id]


def test_a_wording_an_editor_confirmed_is_not_learned_again() -> None:
    confirmed = [wording("glimmer oil", confirmed=True)]
    work_ = work(wordings=confirmed)

    enrichment = work_.enrich(answer().recipes[0], "a-model")

    assert enrichment.wordings == []
    new = {"new": {"name": "glimmer", "family": "oil", "store_category_id": "aisles"}}
    assert errors(work_, answer(line(canonical=new))) == [
        "i2: an editor confirmed glimmer oil's Canonical Ingredient, so it can't be new"
    ]


@pytest.mark.parametrize(
    ("fields", "error"),
    [
        (
            {"canonical": {"id": "01K7Q0000000000000000000ZZ"}},
            "i2: Canonical Ingredient 01K7Q0000000000000000000ZZ wasn't offered",
        ),
        ({"fdc_id": 1002, "portion_id": None}, "i2: FDC food 1002 wasn't offered"),
        ({"portion_id": 503}, "i2: portion 503 isn't one of FDC food 2004's"),
        (
            {"canonical": {"new": {"name": "glim", "family": "oil", "store_category_id": "deli"}}},
            "i2: no Store Category deli",
        ),
        ({"quantity": {"low": 3, "high": None}}, "i2: 3 isn't a number in the line"),
        ({"quantity": {"low": 1, "high": 4}}, "i2: 4 isn't a number in the line"),
        ({"line_id": "i9"}, "no line i9"),
    ],
    ids=[
        "invented canonical",
        "invented fdc_id",
        "another food's portion",
        "unknown store category",
        "invented quantity",
        "invented range end",
        "unknown line",
    ],
)
def test_an_answer_outside_the_offers_is_rejected(fields: dict[str, Any], error: str) -> None:
    assert errors(work(), answer(line(**fields))) == [error]


def test_every_error_in_a_recipe_is_reported() -> None:
    assert errors(work(), answer(line(fdc_id=1), line("i1", portion_id=None))) == [
        "i2: FDC food 1 wasn't offered",
        "i1: Canonical Ingredient 01K7Q0000000000000000000C1 wasn't offered",
        "i1: FDC food 2004 wasn't offered",
    ]


def test_an_unknown_recipe_is_rejected() -> None:
    assert errors(work(), answer(recipe_id="01K7Q0000000000000000000R9")) == [
        "01K7Q0000000000000000000R9 isn't in the packet"
    ]


def test_a_readable_but_different_quantity_corrects_the_parse_and_raises_an_issue() -> None:
    corrected = line(quantity={"low": 2, "high": None}, corrections_reason="1 tsp is too little")

    enrichment = work().enrich(answer(corrected).recipes[0], "a-model")

    parse = enrichment.facts.ingredients["i2"].parse
    assert parse is not None
    assert (parse.provenance, parse.quantity) == ("llm", parse.quantity)
    assert parse.quantity is not None
    assert (parse.quantity.low, parse.quantity.high) == (2, 2)
    (issue,) = enrichment.issues
    assert (issue.fact_id, issue.before, issue.after) == ("i2.parse", "1-2", "2")
    assert issue.reason == "1 tsp is too little"


def test_a_quantity_correction_says_why() -> None:
    assert errors(work(), answer(line(quantity={"low": 2, "high": None}))) == [
        "i2: say why the quantity changed in corrections_reason"
    ]


def test_the_same_quantity_as_the_parse_changes_nothing() -> None:
    enrichment = work().enrich(answer(line(quantity={"low": 1, "high": 2})).recipes[0], "a-model")

    parse = enrichment.facts.ingredients["i2"].parse
    assert parse is not None
    assert parse.provenance == "parser"
    assert enrichment.issues == []


def test_a_doubt_raises_an_issue_and_lowers_the_conversions_confidence() -> None:
    doubted = line(doubts=["Glimmer oil might be the toasted kind"])

    enrichment = work().enrich(answer(doubted).recipes[0], "a-model")

    (issue,) = enrichment.issues
    assert (issue.fact_id, issue.before, issue.after) == ("i2.match", None, "glimmer oil")
    assert issue.reason == "Glimmer oil might be the toasted kind"
    conversion = enrichment.facts.ingredients["i2"].conversion
    assert conversion is not None
    assert conversion.confidence <= 0.5


def test_an_answer_with_unknown_fields_is_refused() -> None:
    with pytest.raises(ValueError, match="density"):
        Answer.model_validate(
            {
                "packet_id": "x",
                "model": "a-model",
                "recipes": [{"recipe_id": RECIPE_ID, "lines": [line(density=0.9)]}],
            }
        )
