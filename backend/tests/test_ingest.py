"""Ingest from a website: the dedupe key, the polite fetcher and the parse into an Original."""

import pytest
import requests
from fake_web import FakeWeb, page

from recipes.ingest import (
    EXTRACTOR,
    USER_AGENT,
    IngestFailed,
    InvalidUrl,
    PageNotFound,
    PoliteFetcher,
    dedupe_key,
    iso_seconds,
    parse,
    website_dedupe_key,
)
from recipes.models import StatedTime
from recipes.seed import RECIPES

URL = "https://plateful.test/miso-soup"
ROBOTS = "https://plateful.test/robots.txt"


@pytest.mark.parametrize(
    ("url", "key"),
    [
        ("https://plateful.test/miso-soup", "https://plateful.test/miso-soup"),
        ("http://plateful.test/miso-soup", "https://plateful.test/miso-soup"),
        ("https://WWW.Plateful.TEST/Miso-Soup", "https://plateful.test/Miso-Soup"),
        ("https://plateful.test/miso-soup/#step-2", "https://plateful.test/miso-soup"),
        ("https://plateful.test/", "https://plateful.test"),
        ("https://plateful.test:443/miso-soup", "https://plateful.test/miso-soup"),
        ("http://plateful.test:80/miso-soup", "https://plateful.test/miso-soup"),
        ("https://plateful.test:8443/miso-soup", "https://plateful.test:8443/miso-soup"),
        (
            (
                "https://plateful.test/miso-soup?utm_source=x&UTM_Medium=y&fbclid=1&gclid=2"
                "&dclid=3&msclkid=4&mc_cid=5&mc_eid=6&_ga=7&igshid=8"
            ),
            "https://plateful.test/miso-soup",
        ),
        (
            "https://plateful.test/recipe?ref=home&id=7&b=2",
            "https://plateful.test/recipe?b=2&id=7&ref=home",
        ),
        ("  https://plateful.test/miso-soup  ", "https://plateful.test/miso-soup"),
    ],
)
def test_a_website_dedupe_key_is_the_normalised_url(url: str, key: str) -> None:
    assert website_dedupe_key(url) == key


@pytest.mark.parametrize(
    "url", ["ftp://plateful.test/x", "plateful.test/x", "https://:443/x", "https://x.test:99999/"]
)
def test_only_an_http_url_with_a_host_has_a_dedupe_key(url: str) -> None:
    with pytest.raises(InvalidUrl):
        website_dedupe_key(url)


def test_each_source_variant_has_its_dedupe_key() -> None:
    website = next(r for r in RECIPES if r.source.kind == "website")
    spreadsheet = next(r for r in RECIPES if r.source.kind == "spreadsheet")

    assert dedupe_key(website.source) == website.dedupe_key
    assert dedupe_key(spreadsheet.source) == "spice-blends/Smoky Taco Seasoning"


@pytest.mark.parametrize(
    ("text", "seconds"),
    [
        ("PT10M", 600),
        ("PT1H15M", 4500),
        ("P1DT2H", 93600),
        ("PT45S", 45),
        (" PT20M ", 1200),
        ("about 20 minutes", None),
        ("1 hour", None),
        ("PT", None),
        ("P1M", None),
        ("PT0.5H", None),
    ],
)
def test_only_an_iso_8601_duration_is_read_as_seconds(text: str, seconds: int | None) -> None:
    assert iso_seconds(text) == seconds


def test_parsing_captures_the_original_as_written() -> None:
    captured = parse(page("json-ld-recipe.html"), URL)
    original = captured.original

    assert captured.site_name == "Plateful Test Kitchen"
    assert original.title == "Weeknight Miso Soup"
    assert original.description == "A quick miso soup with tofu and greens."
    assert original.author == "Test Kitchen Cook"
    assert original.extractor == EXTRACTOR == "recipe-scrapers"
    assert [(i.id, i.text) for i in original.ingredients] == [
        ("i1", "4 cups dashi"),
        ("i2", "3 tbsp white miso"),
        ("i3", "200 g silken tofu, cubed"),
        ("i4", "2 green onions, sliced"),
    ]
    assert [s.id for s in original.steps] == ["s1", "s2", "s3"]
    assert original.steps[0].text == "Warm the dashi until it steams."
    assert original.recipe_yield is not None
    assert original.recipe_yield.text == "Serves 4"
    assert original.recipe_yield.servings is None
    assert original.stated_times.prep == StatedTime(text="PT10M", seconds=600)
    assert original.stated_times.cook == StatedTime(text="about 20 minutes", seconds=None)
    assert original.stated_times.total == StatedTime(text="PT1H15M", seconds=4500)


def test_parsing_a_page_without_a_site_name_or_times() -> None:
    captured = parse(page("json-ld-graph.html"), "https://www.plateful.test/garlic-rice")
    original = captured.original

    assert captured.site_name is None
    assert original.title == "Garlic Rice"
    assert original.author is None
    assert len(original.ingredients) == 3
    assert original.steps
    assert original.recipe_yield is not None
    assert (original.recipe_yield.text, original.recipe_yield.servings) == ("6", 6)
    assert original.stated_times.prep is None
    assert original.stated_times.total is None


def test_a_page_without_a_recipe_waits_for_the_fallback() -> None:
    with pytest.raises(IngestFailed) as failed:
        parse(page("no-recipe.html"), URL)

    assert (failed.value.state, failed.value.reason) == ("waiting", "no_recipe")


def test_the_fetcher_asks_robots_txt_first_as_plateful_once_within_8_seconds() -> None:
    web = FakeWeb({ROBOTS: (200, "User-agent: *\nAllow: /\n"), URL: (200, "<html>page</html>")})

    html = PoliteFetcher(web.session())(URL)

    assert html == "<html>page</html>"
    assert web.urls == [ROBOTS, URL]
    assert all(r.headers["User-Agent"] == USER_AGENT for r in web.requests)
    assert USER_AGENT.startswith("Plateful/")
    assert USER_AGENT.endswith("(+https://github.com/TaylorZowtuk/recipes)")
    assert web.timeouts == [8, 8]


def test_a_missing_robots_txt_allows_the_fetch() -> None:
    web = FakeWeb({ROBOTS: (404, ""), URL: (200, "<html>page</html>")})

    assert PoliteFetcher(web.session())(URL) == "<html>page</html>"


def test_robots_txt_refusing_plateful_needs_the_page_and_never_fetches_it() -> None:
    web = FakeWeb({ROBOTS: (200, "User-agent: Plateful\nDisallow: /\n"), URL: (200, "<html/>")})

    with pytest.raises(IngestFailed) as failed:
        PoliteFetcher(web.session())(URL)

    assert (failed.value.state, failed.value.reason) == ("needs_page", "robots")
    assert web.urls == [ROBOTS]


@pytest.mark.parametrize(
    ("robots", "served", "reason"),
    [
        ((404, ""), (403, "Forbidden"), "blocked"),
        ((404, ""), (429, "Slow down"), "rate_limited"),
        ((404, ""), (503, "Unavailable"), "server_error"),
        ((404, ""), requests.ReadTimeout(), "unreachable"),
        ((404, ""), requests.ConnectionError(), "unreachable"),
        ((503, ""), (200, "<html/>"), "server_error"),
        (requests.ConnectTimeout(), (200, "<html/>"), "unreachable"),
    ],
)
def test_a_failed_fetch_waits_for_the_fallback_without_retrying(
    robots: tuple[int, str] | requests.RequestException,
    served: tuple[int, str] | requests.RequestException,
    reason: str,
) -> None:
    web = FakeWeb({ROBOTS: robots, URL: served})

    with pytest.raises(IngestFailed) as failed:
        PoliteFetcher(web.session())(URL)

    assert (failed.value.state, failed.value.reason) == ("waiting", reason)
    assert len(web.urls) == len(set(web.urls)), "no request is retried"


@pytest.mark.parametrize("status", [404, 410])
def test_a_page_that_is_not_there_is_final(status: int) -> None:
    web = FakeWeb({URL: (status, "")})

    with pytest.raises(PageNotFound):
        PoliteFetcher(web.session())(URL)
