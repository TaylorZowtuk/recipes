"""Ingest from a website: a Source's dedupe key, a polite fetch, and the parse into an Original.

Only the Original is kept. The page's HTML and its schema.org data are read here and dropped.
"""

import re
from dataclasses import dataclass
from http import HTTPStatus
from importlib.metadata import version
from typing import TYPE_CHECKING, Protocol, cast
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import requests
from protego import Protego
from recipe_scrapers import scrape_html
from recipe_scrapers._exceptions import RecipeScrapersExceptions

from recipes.models import (
    IngredientLine,
    Original,
    QueuedIngestReason,
    QueuedIngestState,
    RecipeYield,
    StatedTime,
    StatedTimes,
    Step,
    WebsiteSource,
)

if TYPE_CHECKING:
    from collections.abc import Callable

    from recipes.models import Source

EXTRACTOR = "recipe-scrapers"
ROBOTS_AGENT = "Plateful"
USER_AGENT = f"{ROBOTS_AGENT}/{version('recipes')} (+https://github.com/TaylorZowtuk/recipes)"
# Per request, so robots.txt and the page both fit in the API's 30 s.
TIMEOUT_SECONDS = 8

# Query parameters that only say how someone reached the page. Any other, `ref` included, is kept.
TRACKING = {"fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "_ga", "igshid"}
DEFAULT_PORTS = {"http": 80, "https": 443}

# A scraper for a site it knows may fail on an unexpected page in a plain Python way.
_SCRAPER_ERRORS = (RecipeScrapersExceptions, AttributeError, KeyError, IndexError, TypeError)


class InvalidUrl(ValueError):
    """Not an http(s) URL with a host."""


class PageNotFound(Exception):
    """The site says the page isn't there (404 or 410). Nothing is queued."""


class IngestFailed(Exception):
    """The automated ingest stopped, so the Source becomes a Queued Ingest in `state`."""

    def __init__(self, state: QueuedIngestState, reason: QueuedIngestReason) -> None:
        super().__init__(f"{state}: {reason}")
        self.state: QueuedIngestState = state
        self.reason: QueuedIngestReason = reason


# Dedupe keys


def website_dedupe_key(url: str) -> str:
    """The normalised URL: https, lower-case host without `www.`, no default port, fragment,
    trailing slash or tracking parameters, and the other parameters sorted. Path case is kept.
    """
    parts = urlsplit(url.strip())
    scheme = parts.scheme.lower()
    try:
        port = parts.port
    except ValueError:
        raise InvalidUrl(url) from None
    if scheme not in DEFAULT_PORTS or not parts.hostname:
        raise InvalidUrl(url)
    host = parts.hostname.removeprefix("www.")
    netloc = host if port in {None, DEFAULT_PORTS[scheme]} else f"{host}:{port}"
    query = sorted(
        (name, value)
        for name, value in parse_qsl(parts.query, keep_blank_values=True)
        if not name.lower().startswith("utm_") and name.lower() not in TRACKING
    )
    return urlunsplit(("https", netloc, parts.path.rstrip("/"), urlencode(query), ""))


def dedupe_key(source: Source) -> str:
    if isinstance(source, WebsiteSource):
        return website_dedupe_key(source.url)
    return f"{source.sheet_id}/{source.entry_name}"


def site_host(dedupe_key: str) -> str:
    """A website's name when its page doesn't give one: the host of its dedupe key."""
    return urlsplit(dedupe_key).netloc


# Fetching


class Fetcher(Protocol):
    def __call__(self, url: str) -> str:
        """The page's HTML. Raises PageNotFound, or IngestFailed for a Queued Ingest."""
        ...


class PoliteFetcher:
    """Fetches a page as Plateful, only if the site's robots.txt allows it, each request once."""

    def __init__(self, session: requests.Session | None = None) -> None:
        self.session = session or requests.Session()
        self.session.headers["User-Agent"] = USER_AGENT

    def __call__(self, url: str) -> str:
        if not self._allowed(url):
            raise IngestFailed(state="needs_page", reason="robots")
        response = self._get(url)
        if response.status_code in {HTTPStatus.NOT_FOUND, HTTPStatus.GONE}:
            raise PageNotFound(url)
        _raise_for_status(response)
        return _text(response)

    def _allowed(self, url: str) -> bool:
        parts = urlsplit(url)
        robots = self._get(urlunsplit((parts.scheme, parts.netloc, "/robots.txt", "", "")))
        # RFC 9309: a robots.txt that's unavailable (4xx) allows everything, and one that's
        # unreachable (5xx) disallows everything for now, so the Source waits.
        if HTTPStatus.BAD_REQUEST <= robots.status_code < HTTPStatus.INTERNAL_SERVER_ERROR:
            return True
        _raise_for_status(robots)
        return Protego.parse(_text(robots)).can_fetch(url, ROBOTS_AGENT)

    def _get(self, url: str) -> requests.Response:
        try:
            return self.session.get(url, timeout=TIMEOUT_SECONDS)
        except requests.RequestException:
            raise IngestFailed(state="waiting", reason="unreachable") from None


def _raise_for_status(response: requests.Response) -> None:
    status = response.status_code
    if status == HTTPStatus.TOO_MANY_REQUESTS:
        raise IngestFailed(state="waiting", reason="rate_limited")
    if status >= HTTPStatus.INTERNAL_SERVER_ERROR:
        raise IngestFailed(state="waiting", reason="server_error")
    if status >= HTTPStatus.BAD_REQUEST:
        raise IngestFailed(state="waiting", reason="blocked")


def _text(response: requests.Response) -> str:
    # requests decodes text without a charset as ISO-8859-1, but such pages are nearly all UTF-8.
    if "charset" not in response.headers.get("Content-Type", "").lower():
        response.encoding = "utf-8"
    return response.text


# Parsing


@dataclass(frozen=True)
class Captured:
    original: Original
    site_name: str | None  # as the page names its site, if it does


def parse(html: str, url: str) -> Captured:
    """The page's recipe as written. Raises IngestFailed when it has none."""
    try:
        scraper = scrape_html(html, org_url=url, supported_only=False)
        title = cast("str | None", scraper.title())
        groups = scraper.ingredient_groups()
        steps = scraper.instructions_list()
    except _SCRAPER_ERRORS:
        raise IngestFailed(state="waiting", reason="no_recipe") from None
    ingredients = [(group.purpose, text) for group in groups for text in group.ingredients]
    if not title or not ingredients:
        raise IngestFailed(state="waiting", reason="no_recipe")
    data = cast("dict[str, object]", scraper.schema.data)  # pyright: ignore[reportUnknownMemberType]
    original = Original(
        title=title,
        description=_optional(scraper.description),
        author=_optional(scraper.author),
        extractor=EXTRACTOR,
        ingredients=[
            IngredientLine(id=f"i{n}", component=component, text=text)
            for n, (component, text) in enumerate(ingredients, 1)
        ],
        steps=[Step(id=f"s{n}", text=text) for n, text in enumerate(steps, 1)],
        recipe_yield=_yield(data.get("recipeYield")),
        stated_times=StatedTimes(
            prep=_stated_time(data.get("prepTime")),
            cook=_stated_time(data.get("cookTime")),
            total=_stated_time(data.get("totalTime")),
        ),
    )
    return Captured(original=original, site_name=_optional(scraper.site_name))


def _optional(field: Callable[[], object]) -> str | None:
    try:
        value = field()
    except (*_SCRAPER_ERRORS, NotImplementedError):
        return None
    return (value.strip() or None) if isinstance(value, str) else None


def _yield(value: object) -> RecipeYield | None:
    """The yield as written. Its servings only when it's a bare number, else enrichment's job."""
    if isinstance(value, list) and value:
        value = cast("list[object]", value)[0]
    if isinstance(value, int) and not isinstance(value, bool):
        return RecipeYield(text=str(value), servings=value)
    if isinstance(value, str) and value.strip():
        servings = int(value) if value.strip().isdigit() else None
        return RecipeYield(text=value, servings=servings)
    return None


def _stated_time(value: object) -> StatedTime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return StatedTime(text=value, seconds=iso_seconds(value))


_ISO_DURATION = re.compile(r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?")


def iso_seconds(text: str) -> int | None:
    """The seconds in an ISO 8601 duration of whole days, hours, minutes and seconds. Any other
    text, months and fractions included, is left for enrichment.
    """
    match = _ISO_DURATION.fullmatch(text.strip())
    if match is None or not any(match.groups()):
        return None
    days, hours, minutes, seconds = (int(part or 0) for part in match.groups())
    return ((days * 24 + hours) * 60 + minutes) * 60 + seconds
