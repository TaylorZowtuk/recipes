"""Ingest from a website: the dedupe key, the polite fetcher and the parse into an Original."""

import gzip
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from itertools import chain, count, repeat
from typing import TYPE_CHECKING

import pytest
import requests
from fake_web import PUBLIC_ADDRESS, FakeWeb, Redirect, Served, page

from recipes.ingest import (
    EXTRACTOR,
    MAX_PAGE_BYTES,
    MAX_ROBOTS_BYTES,
    USER_AGENT,
    FetchRefused,
    IngestFailed,
    InvalidUrl,
    Page,
    PageNotFound,
    PoliteFetcher,
    dedupe_key,
    iso_seconds,
    parse,
    resolve,
    website_dedupe_key,
)
from recipes.models import StatedTime
from recipes.seed import RECIPES

if TYPE_CHECKING:
    from collections.abc import Iterator

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
        ("https://plateful.test/miso-soup?FBCLID=1", "https://plateful.test/miso-soup"),
    ],
)
def test_a_website_dedupe_key_is_the_normalised_url(url: str, key: str) -> None:
    assert website_dedupe_key(url) == key


@pytest.mark.parametrize(
    "url",
    [
        "ftp://plateful.test/x",
        "plateful.test/x",
        "https://:443/x",
        "https://x.test:99999/",
        f"https://{'a' * 64}.test/x",
        "https://a..test/x",
    ],
)
def test_only_an_http_url_with_a_host_has_a_dedupe_key(url: str) -> None:
    with pytest.raises(InvalidUrl):
        website_dedupe_key(url)


def test_a_dedupe_key_fits_a_dynamodb_key_at_2000_bytes() -> None:
    longest = "https://plateful.test/" + "a" * (2000 - len("https://plateful.test/"))

    assert website_dedupe_key(longest) == longest
    with pytest.raises(InvalidUrl):
        website_dedupe_key(longest + "a")
    with pytest.raises(InvalidUrl):
        # Normalising percent-encodes the query, so the key is longer than the URL.
        website_dedupe_key("https://plateful.test/?q=" + "é" * 400)


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

    assert (type(failed.value), failed.value.reason) == (IngestFailed, "no_recipe")


def test_a_sites_own_scraper_failing_on_its_page_is_no_recipe() -> None:
    # This host has its own scraper, which expects ingredient markup the page doesn't have.
    with pytest.raises(IngestFailed) as failed:
        parse(page("json-ld-recipe.html"), "https://www.bbcgoodfood.com/recipes/miso-soup")

    assert (type(failed.value), failed.value.reason) == (IngestFailed, "no_recipe")


def test_a_recipe_past_an_originals_limits_is_no_recipe() -> None:
    html = page("json-ld-recipe.html").replace("Weeknight Miso Soup", "Miso " * 61)

    with pytest.raises(IngestFailed) as failed:
        parse(html, URL)

    assert (type(failed.value), failed.value.reason) == (IngestFailed, "no_recipe")


def test_importing_ingest_leaves_recipe_scrapers_for_the_first_parse() -> None:
    code = "import sys, recipes.api; sys.exit('recipe_scrapers' in sys.modules)"

    assert subprocess.run([sys.executable, "-c", code], check=False).returncode == 0


def test_the_fetcher_asks_robots_txt_first_as_plateful_once_within_3_and_8_seconds() -> None:
    web = FakeWeb({ROBOTS: (200, "User-agent: *\nAllow: /\n"), URL: (200, "<html>page</html>")})

    fetched = web.fetcher()(URL)

    assert fetched == Page(html="<html>page</html>", url=URL)
    assert web.urls == [ROBOTS, URL]
    assert all(r.headers["User-Agent"] == USER_AGENT for r in web.requests)
    assert USER_AGENT == "Plateful/1 (+https://github.com/TaylorZowtuk/recipes)"
    assert web.timeouts == [(3, 8), (3, 8)]


def test_a_missing_robots_txt_allows_the_fetch() -> None:
    web = FakeWeb({ROBOTS: (404, ""), URL: (200, "<html>page</html>")})

    assert web.fetcher()(URL).html == "<html>page</html>"


def test_robots_txt_refusing_plateful_needs_the_page_and_never_fetches_it() -> None:
    web = FakeWeb({ROBOTS: (200, "User-agent: Plateful\nDisallow: /\n"), URL: (200, "<html/>")})

    with pytest.raises(IngestFailed) as failed:
        web.fetcher()(URL)

    assert (type(failed.value), failed.value.reason) == (FetchRefused, "robots")
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
        web.fetcher()(URL)

    assert (type(failed.value), failed.value.reason) == (IngestFailed, reason)
    assert len(web.urls) == len(set(web.urls)), "no request is retried"


@pytest.mark.parametrize("status", [404, 410])
def test_a_page_that_is_not_there_is_final(status: int) -> None:
    web = FakeWeb({URL: (status, "")})

    with pytest.raises(PageNotFound):
        web.fetcher()(URL)


def test_a_redirect_on_the_same_host_is_followed_under_the_same_robots_txt() -> None:
    moved = "https://plateful.test/recipes/miso-soup"
    web = FakeWeb(
        {
            ROBOTS: (200, "User-agent: *\nAllow: /\n"),
            URL: Redirect("/recipes/miso-soup"),
            moved: (200, "<html>page</html>"),
        }
    )

    assert web.fetcher()(URL) == Page(html="<html>page</html>", url=moved)
    assert web.urls == [ROBOTS, URL, moved]


def test_a_redirects_body_is_left_unread_however_large() -> None:
    moved = "https://plateful.test/recipes/miso-soup"
    web = FakeWeb(
        {
            ROBOTS: (404, ""),
            URL: Redirect(moved, body="x" * (MAX_PAGE_BYTES + 1)),
            moved: (200, "<html>page</html>"),
        }
    )

    assert web.fetcher()(URL) == Page(html="<html>page</html>", url=moved)
    assert web.bodies[1].read_bytes == 0


def test_a_redirect_the_target_hosts_robots_txt_refuses_needs_the_page_and_is_not_followed() -> (
    None
):
    moved = "https://elsewhere.test/miso-soup"
    web = FakeWeb(
        {
            ROBOTS: (200, "User-agent: *\nAllow: /\n"),
            URL: Redirect(moved),
            "https://elsewhere.test/robots.txt": (200, "User-agent: Plateful\nDisallow: /\n"),
            moved: (200, "<html/>"),
        }
    )

    with pytest.raises(IngestFailed) as failed:
        web.fetcher()(URL)

    assert (type(failed.value), failed.value.reason) == (FetchRefused, "robots")
    assert moved not in web.urls


def test_each_hosts_robots_txt_is_fetched_once_across_redirects() -> None:
    other = "https://elsewhere.test"
    web = FakeWeb(
        {
            ROBOTS: (200, "User-agent: *\nAllow: /\n"),
            URL: Redirect(f"{other}/a"),
            f"{other}/robots.txt": (200, "User-agent: *\nAllow: /\n"),
            f"{other}/a": Redirect(f"{other}/b", status=302),
            f"{other}/b": Redirect("https://plateful.test/c", status=308),
            "https://plateful.test/c": (200, "<html>page</html>"),
        }
    )

    assert web.fetcher()(URL) == Page(html="<html>page</html>", url="https://plateful.test/c")
    assert web.urls == [
        ROBOTS,
        URL,
        f"{other}/robots.txt",
        f"{other}/a",
        f"{other}/b",
        "https://plateful.test/c",
    ]


def test_a_redirect_loop_waits_for_the_fallback_after_five_redirects() -> None:
    other = "https://plateful.test/loop"
    web = FakeWeb({ROBOTS: (404, ""), URL: Redirect(other), other: Redirect(URL)})

    with pytest.raises(IngestFailed) as failed:
        web.fetcher()(URL)

    assert (type(failed.value), failed.value.reason) == (IngestFailed, "unreachable")
    assert web.urls == [ROBOTS, URL, other, URL, other, URL, other]


@pytest.mark.parametrize("location", ["http://[::1/x", "//[zz"])
def test_a_malformed_redirect_waits_for_the_fallback(location: str) -> None:
    web = FakeWeb({ROBOTS: (404, ""), URL: Redirect(location)})

    with pytest.raises(IngestFailed) as failed:
        web.fetcher()(URL)

    assert (type(failed.value), failed.value.reason) == (IngestFailed, "unreachable")
    assert web.urls == [ROBOTS, URL]


def test_an_ingest_that_runs_past_its_deadline_waits_for_the_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = chain([0.0, 1.0, 15.0], repeat(15.0))
    monkeypatch.setattr("recipes.ingest.monotonic", lambda: next(clock))
    web = FakeWeb({ROBOTS: (404, ""), URL: (200, "<html/>")})

    with pytest.raises(IngestFailed) as failed:
        web.fetcher()(URL)

    assert (type(failed.value), failed.value.reason) == (IngestFailed, "unreachable")
    assert web.urls == [ROBOTS]


def test_a_request_near_the_deadline_is_given_only_the_time_left(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = chain([0.0, 1.0, 11.0], repeat(11.0))
    monkeypatch.setattr("recipes.ingest.monotonic", lambda: next(clock))
    web = FakeWeb({ROBOTS: (404, ""), URL: (200, "<html/>")})

    web.fetcher()(URL)

    assert web.timeouts == [(3, 8), (3, 3.0)]


class _SlowRobots(BaseHTTPRequestHandler):
    """A robots.txt that redirects again and again, each hop answering after 0.3 s."""

    def do_GET(self) -> None:
        time.sleep(0.3)
        self.send_response(302)
        self.send_header("Location", f"{self.path}/next")
        self.end_headers()


@pytest.fixture
def slow_site() -> Iterator[str]:
    """A real local site, for what FakeWeb can't fake: requests waiting on a slow connection."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), _SlowRobots)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()
    server.server_close()


def test_a_slow_robots_txt_redirect_chain_ends_unreachable_at_the_deadline(
    monkeypatch: pytest.MonkeyPatch, slow_site: str
) -> None:
    monkeypatch.setattr("recipes.ingest.DEADLINE_SECONDS", 1)
    fetcher = PoliteFetcher(resolve=lambda _host: [PUBLIC_ADDRESS])
    started = time.monotonic()

    with pytest.raises(IngestFailed) as failed:
        fetcher(f"{slow_site}/miso-soup")
    elapsed = time.monotonic() - started

    assert (type(failed.value), failed.value.reason) == (IngestFailed, "unreachable")
    assert elapsed < 1.2, f"ended after {elapsed:.2f} s"


def test_a_page_that_drips_past_the_deadline_waits_for_the_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = count()  # a second passes each time the fetcher looks
    monkeypatch.setattr("recipes.ingest.monotonic", lambda: float(next(clock)))
    web = FakeWeb({ROBOTS: (404, ""), URL: Served(200, "<html>" + "x" * 100, drip=True)})

    with pytest.raises(IngestFailed) as failed:
        web.fetcher()(URL)

    assert (type(failed.value), failed.value.reason) == (IngestFailed, "unreachable")


@pytest.mark.parametrize(
    ("robots", "served"),
    [
        ((404, ""), (200, "x" * (MAX_PAGE_BYTES + 1))),
        ((200, "#" * (MAX_ROBOTS_BYTES + 1)), (200, "<html/>")),
    ],
)
def test_a_body_past_its_size_limit_waits_for_the_fallback(
    robots: tuple[int, str], served: tuple[int, str]
) -> None:
    web = FakeWeb({ROBOTS: robots, URL: served})

    with pytest.raises(IngestFailed) as failed:
        web.fetcher()(URL)

    assert (type(failed.value), failed.value.reason) == (IngestFailed, "unreachable")


def test_a_gzipped_page_is_read_as_its_html() -> None:
    web = FakeWeb({ROBOTS: (404, ""), URL: Served(200, "<html>page</html>", encoding="gzip")})

    assert web.fetcher()(URL).html == "<html>page</html>"


def test_a_small_gzipped_page_that_decodes_past_its_limit_waits_for_the_fallback() -> None:
    served = Served(200, "x" * (MAX_PAGE_BYTES + 1), encoding="gzip")
    web = FakeWeb({ROBOTS: (404, ""), URL: served})
    assert len(gzip.compress(b"x" * (MAX_PAGE_BYTES + 1))) < MAX_PAGE_BYTES // 100

    with pytest.raises(IngestFailed) as failed:
        web.fetcher()(URL)

    assert (type(failed.value), failed.value.reason) == (IngestFailed, "unreachable")


def test_a_page_without_a_charset_is_read_as_utf_8() -> None:
    body = "<html>Crème brûlée</html>"
    web = FakeWeb({ROBOTS: (404, ""), URL: Served(200, body.encode(), content_type="text/html")})

    assert web.fetcher()(URL).html == body


def test_a_redirect_to_loopback_is_refused_and_never_requested() -> None:
    web = FakeWeb({ROBOTS: (404, ""), URL: Redirect("http://127.0.0.1:9/internal")})

    with pytest.raises(FetchRefused) as failed:
        web.fetcher()(URL)

    assert failed.value.reason == "blocked"
    assert web.urls == [ROBOTS, URL]


def test_a_robots_txt_redirect_to_loopback_is_refused_and_never_requested() -> None:
    web = FakeWeb({ROBOTS: Redirect("http://127.0.0.1:9/robots.txt", status=302)})

    with pytest.raises(FetchRefused) as failed:
        web.fetcher()(URL)

    assert failed.value.reason == "blocked"
    assert web.urls == [ROBOTS]


@pytest.mark.parametrize(
    ("url", "addresses"),
    [
        ("http://127.0.0.1/", ["127.0.0.1"]),
        ("http://[::1]/", ["::1"]),
        (URL, ["10.0.0.5"]),
        (URL, ["8.8.8.8", "169.254.169.254"]),
    ],
)
def test_a_url_off_the_public_internet_is_refused_before_any_request(
    url: str, addresses: list[str]
) -> None:
    web = FakeWeb()

    with pytest.raises(FetchRefused) as failed:
        PoliteFetcher(web.session(), resolve=lambda _host: addresses)(url)

    assert failed.value.reason == "blocked"
    assert web.urls == []


def test_the_address_checked_is_the_one_requests_connects_to() -> None:
    # getaddrinfo encodes this host as IDNA 2003, fass.de; requests as IDNA 2008, xn--fa-hia.de.
    addresses = {"xn--fa-hia.de": ["127.0.0.1"], "fass.de": [PUBLIC_ADDRESS]}
    web = FakeWeb()

    with pytest.raises(FetchRefused) as failed:
        PoliteFetcher(web.session(), resolve=lambda host: addresses[host.encode("idna").decode()])(
            "http://faß.de/x"
        )

    assert failed.value.reason == "blocked"
    assert web.urls == []


def test_a_host_that_does_not_resolve_waits_for_the_fallback() -> None:
    def unresolved(host: str) -> list[str]:
        raise socket.gaierror(host)

    with pytest.raises(IngestFailed) as failed:
        PoliteFetcher(FakeWeb().session(), resolve=unresolved)(URL)

    assert (type(failed.value), failed.value.reason) == (IngestFailed, "unreachable")


def test_a_redirect_to_a_host_that_cannot_be_encoded_waits_for_the_fallback() -> None:
    web = FakeWeb({ROBOTS: (404, ""), URL: Redirect("http://a..test/")})

    def lookup(host: str) -> list[str]:
        # The real lookup for the bad host, which fails before anything reaches the network.
        return web.resolve(host) if host == "plateful.test" else resolve(host)

    fetcher = PoliteFetcher(web.session(), resolve=lookup)

    with pytest.raises(IngestFailed) as failed:
        fetcher(URL)

    assert (type(failed.value), failed.value.reason) == (IngestFailed, "unreachable")
    assert web.urls == [ROBOTS, URL]
