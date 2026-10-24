import pytest
from pydantic import ValidationError

from recipes.models import (
    MAX_ORIGINAL_BYTES,
    Original,
    SourceGuard,
    SpreadsheetSource,
    Step,
    WebsiteSource,
    new_ulid,
)
from recipes.seed import CAPTURED_AT


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
