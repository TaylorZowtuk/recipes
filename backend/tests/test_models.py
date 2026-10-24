import pytest
from pydantic import ValidationError

from recipes.models import SourceGuard, SpreadsheetSource, WebsiteSource, new_ulid
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
