import pytest
from pydantic import ValidationError

from recipes.models import (
    MAX_ORIGINAL_BYTES,
    Original,
    Recipe,
    SourceGuard,
    SpreadsheetSource,
    Step,
    SubstitutionsFact,
    WebsiteSource,
    new_ulid,
    normalize_wording,
    written_as,
)
from recipes.seed import CAPTURED_AT, RECIPES


@pytest.mark.parametrize("url", ["javascript:alert(1)", "data:text/html,hi", "example.com/x"])
def test_a_source_links_only_to_the_web(url: str) -> None:
    with pytest.raises(ValidationError):
        WebsiteSource(url=url, site_name="Example Kitchen", captured_at=CAPTURED_AT)
    with pytest.raises(ValidationError):
        SpreadsheetSource(url=url, sheet_id="sheet", entry_name="Entry", captured_at=CAPTURED_AT)


def test_a_source_keeps_its_url_exactly() -> None:
    url = "http://example.com/Recipe?id=7#top"

    source = WebsiteSource(url=url, site_name="Example Kitchen", captured_at=CAPTURED_AT)

    assert source.url == url


def test_new_ulids_are_valid_and_sort_by_creation() -> None:
    first, second = new_ulid(), new_ulid()

    for ulid in (first, second):
        assert SourceGuard(schema_version=1, recipe_id=ulid).recipe_id == ulid
    assert first[:10] <= second[:10], "the timestamp comes first"
    assert first != second


def test_an_original_fits_a_dynamodb_item_at_its_size_limit() -> None:
    def original(steps: list[Step], last: str) -> Original:
        return Original(
            title="Long Soup",
            extractor="recipe-scrapers",
            ingredients=[],
            steps=[*steps, Step(id="last", text=last)],
        )

    # Full steps until a last step's text can make up the rest, within its own 2000 characters.
    steps: list[Step] = []
    while len(original(steps, "").model_dump_json()) < MAX_ORIGINAL_BYTES - 1600:
        steps.append(Step(id=f"s{len(steps)}", text="x" * 1500))
    room = MAX_ORIGINAL_BYTES - len(original(steps, "").model_dump_json())

    assert len(original(steps, "x" * room).model_dump_json()) == MAX_ORIGINAL_BYTES
    with pytest.raises(ValidationError):
        original(steps, "x" * (room + 1))


@pytest.mark.parametrize(
    ("name", "wording"),
    [
        ("Boneless Chicken Thighs", "boneless chicken thighs"),
        ("  red   onion\t", "red onion"),
        ('"fresh basil."', "fresh basil"),
        ("salt, to taste", "salt, to taste"),
        ("eggs", "eggs"),
    ],
)
def test_a_wording_is_normalized_without_singularizing(name: str, wording: str) -> None:
    assert normalize_wording(name) == wording


@pytest.mark.parametrize(
    "recipe", [r for r in RECIPES if r.facts.steps], ids=lambda r: r.original.title
)
def test_the_seeds_step_segments_are_their_steps_text(recipe: Recipe) -> None:
    texts = {step.id: step.text for step in recipe.original.steps}
    lines = {line.id for line in recipe.original.ingredients}
    portions: dict[str, float] = {}
    for step_id, facts in recipe.facts.steps.items():
        if facts.segments:
            assert "".join(written_as(s) for s in facts.segments.segments) == texts[step_id]
        for use in facts.uses.uses if facts.uses else []:
            assert use.ref in lines
            portions[use.ref] = portions.get(use.ref, 0) + use.portion
    assert all(total <= 1 for total in portions.values())


FDC_NUMBERS = {
    "dataset": "sr_legacy",
    "release": "foundation-2026-04-01+sr_legacy-2018-04",
    "density_g_per_ml": 1.03,
    "grams_per_count": None,
    "count_unit": None,
    "refused": None,
    "per_100g": {"kcal": 60, "protein_g": 3, "fat_g": 3, "carbs_g": 5, "sodium_mg": 40},
}


def substitution(**fields: object) -> dict[str, object]:
    return {
        "wording": "whole milk",
        "canonical_id": "01K7Q0000000000000000000C3",
        "ratio": 1,
        "note": "a little thinner",
        "fdc_id": 1003,
        "portion_id": None,
        "fdc": FDC_NUMBERS,
        **fields,
    }


def substitutions(*items: dict[str, object]) -> SubstitutionsFact:
    return SubstitutionsFact.model_validate(
        {"provenance": "llm", "confidence": 0.6, "estimated": True, "items": list(items)}
    )


@pytest.mark.parametrize("ratio", [0.05, 1, 10])
def test_a_substitutions_ratio_is_more_than_none_and_at_most_ten(ratio: float) -> None:
    assert substitutions(substitution(ratio=ratio)).items[0].ratio == ratio


@pytest.mark.parametrize("ratio", [0, -1, 10.5, float("inf"), float("nan")])
def test_a_substitution_ratio_out_of_bounds_is_refused(ratio: float) -> None:
    with pytest.raises(ValidationError):
        substitutions(substitution(ratio=ratio))


def test_a_substitutions_fact_has_at_least_one_item() -> None:
    with pytest.raises(ValidationError):
        substitutions()
