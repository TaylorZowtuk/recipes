"""Ingest from a website: a Source's dedupe key, a polite fetch, and the parse into an Original.

Only the Original is kept. The page's HTML and its schema.org data are read here and dropped.
"""

import ipaddress
import re
import socket
from dataclasses import dataclass
from http import HTTPStatus
from time import monotonic
from typing import TYPE_CHECKING, Protocol, cast
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit

import requests
import urllib3
from protego import Protego

from recipes.models import (
    MAX_LABEL,
    IngredientLine,
    Original,
    QueuedIngestReason,
    RecipeYield,
    StatedTime,
    StatedTimes,
    Step,
    WebsiteSource,
)

if TYPE_CHECKING:
    from collections.abc import Callable

    from recipe_scrapers._abstract import AbstractScraper

    from recipes.models import Source

EXTRACTOR = "recipe-scrapers"
ROBOTS_AGENT = "Plateful"
USER_AGENT = f"{ROBOTS_AGENT}/1 (+https://github.com/TaylorZowtuk/recipes)"
# Per request, and a deadline for the whole fetch, bodies included, so robots.txt, a page and its
# redirects still answer inside the API's 30 s: a read that stalls just before the deadline ends
# by 22 s. Running out of either, of redirects, or of the size a body may decode to, is unreachable.
TIMEOUT_SECONDS = 8
DEADLINE_SECONDS = 14
MAX_REDIRECTS = 5
MAX_PAGE_BYTES = 5 * 1024 * 1024
MAX_ROBOTS_BYTES = 512 * 1024
CHUNK_BYTES = 64 * 1024

# Query parameters that only say how someone reached the page. Any other, `ref` included, is kept.
TRACKING = {"fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "_ga", "igshid"}
DEFAULT_PORTS = {"http": 80, "https": 443}
# Under DynamoDB's 2048-byte key, with room for the guard's `SOURCE#` prefix.
MAX_KEY_BYTES = 2000


class InvalidUrl(ValueError):
    """Not an http(s) URL with a host IDNA can encode, or too long to be a key."""


class PageNotFound(Exception):
    """The site says the page isn't there (404 or 410). Nothing is queued."""


class IngestFailed(Exception):
    """The automated ingest stopped for `reason`, and a later automated attempt may succeed."""

    def __init__(self, reason: QueuedIngestReason) -> None:
        super().__init__(reason)
        self.reason: QueuedIngestReason = reason


class FetchRefused(IngestFailed):
    """No automated fetch may be tried: robots.txt refuses it, or it leads off the public web."""


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
    try:
        parts.hostname.encode("idna")
    except UnicodeError:
        raise InvalidUrl(url) from None
    host = parts.hostname.removeprefix("www.")
    netloc = host if port in {None, DEFAULT_PORTS[scheme]} else f"{host}:{port}"
    query = sorted(
        (name, value)
        for name, value in parse_qsl(parts.query, keep_blank_values=True)
        if not name.lower().startswith("utm_") and name.lower() not in TRACKING
    )
    key = urlunsplit(("https", netloc, parts.path.rstrip("/"), urlencode(query), ""))
    if len(key.encode()) > MAX_KEY_BYTES:
        raise InvalidUrl(url)
    return key


def dedupe_key(source: Source) -> str:
    if isinstance(source, WebsiteSource):
        return website_dedupe_key(source.url)
    return f"{source.sheet_id}/{source.entry_name}"


def site_host(dedupe_key: str) -> str:
    """A website's name when its page doesn't give one: the host of its dedupe key, cut to a
    Label's length like a page's own name.
    """
    return urlsplit(dedupe_key).netloc[:MAX_LABEL]


# Fetching


@dataclass(frozen=True)
class Page:
    html: str
    url: str  # where the page finally came from, after any redirects


class Fetcher(Protocol):
    def __call__(self, url: str) -> Page:
        """The page. Raises PageNotFound, or IngestFailed for a Queued Ingest."""
        ...


def resolve(host: str) -> list[str]:
    """The addresses `host` resolves to."""
    return [str(info[4][0]) for info in socket.getaddrinfo(host, None)]


class PoliteFetcher:
    """Fetches a page as Plateful, each request once, following a redirect only where the
    robots.txt of the host it leads to allows it, and only to a host on the public internet.
    """

    def __init__(
        self,
        session: requests.Session | None = None,
        resolve: Callable[[str], list[str]] = resolve,
    ) -> None:
        self.session = session or requests.Session()
        self.session.headers["User-Agent"] = USER_AGENT
        # Pages are redirected by hand, with a robots check per hop; this caps the redirects
        # requests follows itself, for robots.txt.
        self.session.max_redirects = MAX_REDIRECTS
        self.resolve = resolve

    def __call__(self, url: str) -> Page:
        deadline = monotonic() + DEADLINE_SECONDS
        robots: dict[str, Protego | None] = {}
        for _ in range(MAX_REDIRECTS + 1):
            self._refuse_unless_public(url)
            if not self._allowed(url, robots, deadline):
                raise FetchRefused(reason="robots")
            with self._get(url, deadline, follow=False) as response:
                if not response.is_redirect:
                    if response.status_code in {HTTPStatus.NOT_FOUND, HTTPStatus.GONE}:
                        raise PageNotFound(url)
                    _raise_for_status(response)
                    return Page(html=_text(response, deadline, MAX_PAGE_BYTES), url=url)
                url = urljoin(url, response.headers["Location"])
        # A redirect loop, like a page that never answers.
        raise IngestFailed(reason="unreachable")

    def _refuse_unless_public(self, url: str) -> None:
        """Loopback, private and other non-global addresses are never fetched, so a pasted URL
        or a redirect can't reach the machine Plateful runs on or its network.
        """
        try:
            addresses = self.resolve(urlsplit(url).hostname or "")
        except OSError, UnicodeError:
            raise IngestFailed(reason="unreachable") from None
        if not all(ipaddress.ip_address(a.partition("%")[0]).is_global for a in addresses):
            raise FetchRefused(reason="blocked")

    def _allowed(self, url: str, robots: dict[str, Protego | None], deadline: float) -> bool:
        """Whether the robots.txt of `url`'s origin allows it, reading each origin's once."""
        parts = urlsplit(url)
        origin = urlunsplit((parts.scheme, parts.netloc, "", "", ""))
        if origin not in robots:
            robots[origin] = self._robots(f"{origin}/robots.txt", deadline)
        rules = robots[origin]
        return rules is None or rules.can_fetch(url, ROBOTS_AGENT)

    def _robots(self, url: str, deadline: float) -> Protego | None:
        with self._get(url, deadline, follow=True) as robots:
            # RFC 9309: a robots.txt that's unavailable (4xx) allows everything, and one that's
            # unreachable (5xx) disallows everything for now, so the Source waits.
            if HTTPStatus.BAD_REQUEST <= robots.status_code < HTTPStatus.INTERNAL_SERVER_ERROR:
                return None
            _raise_for_status(robots)
            return Protego.parse(_text(robots, deadline, MAX_ROBOTS_BYTES))

    def _public_hop(self, response: requests.Response, *_args: object, **_kwargs: object) -> None:
        """Called on each response when requests follows the redirects, as it does for robots.txt,
        so a redirect off the public internet is refused before it's requested, as a page's is.
        """
        if response.is_redirect:
            self._refuse_unless_public(urljoin(response.url, response.headers["Location"]))

    def _get(self, url: str, deadline: float, *, follow: bool) -> requests.Response:
        remaining = deadline - monotonic()
        if remaining <= 0:
            raise IngestFailed(reason="unreachable")
        try:
            return self.session.get(
                url,
                timeout=min(TIMEOUT_SECONDS, remaining),
                allow_redirects=follow,
                stream=True,
                hooks={"response": self._public_hop} if follow else None,
            )
        except requests.RequestException:
            raise IngestFailed(reason="unreachable") from None


def _raise_for_status(response: requests.Response) -> None:
    status = response.status_code
    if status == HTTPStatus.TOO_MANY_REQUESTS:
        raise IngestFailed(reason="rate_limited")
    if status >= HTTPStatus.INTERNAL_SERVER_ERROR:
        raise IngestFailed(reason="server_error")
    if status >= HTTPStatus.BAD_REQUEST:
        raise IngestFailed(reason="blocked")


def _text(response: requests.Response, deadline: float, max_bytes: int) -> str:
    """The body as text, read as it arrives, so a page that drips past the deadline or decodes
    to more than `max_bytes` is given up on. read1 returns whatever has arrived rather than
    waiting for a whole chunk.
    """
    body = bytearray()
    try:
        while chunk := response.raw.read1(CHUNK_BYTES, decode_content=True):
            body += chunk
            if len(body) > max_bytes or monotonic() > deadline:
                raise IngestFailed(reason="unreachable")
    except urllib3.exceptions.HTTPError, OSError:
        raise IngestFailed(reason="unreachable") from None
    # requests decodes text without a charset as ISO-8859-1, but such pages are nearly all UTF-8.
    charset = "charset" in response.headers.get("Content-Type", "").lower()
    try:
        return body.decode((charset and response.encoding) or "utf-8", errors="replace")
    except LookupError:
        return body.decode("utf-8", errors="replace")


# Parsing


@dataclass(frozen=True)
class Captured:
    original: Original
    site_name: str | None  # as the page names its site, if it does


def parse(html: str, url: str) -> Captured:
    """The page's recipe as written, scraped as the site at `url` lays it out. Raises
    IngestFailed when it has none, or when what it has is too big for an Original.
    """
    # Imported here, not at load: its hundreds of site modules would slow every cold start.
    from recipe_scrapers import scrape_html

    # A site's own scraper fails in its own ways on a page it doesn't expect, so any error
    # means no recipe was found, as does a recipe past an Original's limits.
    try:
        scraper = scrape_html(html, org_url=url, supported_only=False)
        original = _original(scraper)
    except Exception:
        raise IngestFailed(reason="no_recipe") from None
    if original is None:
        raise IngestFailed(reason="no_recipe")
    site_name = _optional(scraper.site_name)
    return Captured(original=original, site_name=site_name and site_name[:MAX_LABEL])


def _original(scraper: AbstractScraper) -> Original | None:
    """The scraper's recipe as an Original, or None without a title or an ingredient."""
    title = cast("str | None", scraper.title())
    ingredients = [
        (group.purpose, text) for group in scraper.ingredient_groups() for text in group.ingredients
    ]
    steps = scraper.instructions_list()
    if not title or not ingredients:
        return None
    data = cast("dict[str, object]", scraper.schema.data)  # pyright: ignore[reportUnknownMemberType]
    return Original(
        title=title,
        description=_optional(scraper.description),
        author=_optional(scraper.author),
        extractor=EXTRACTOR,
        ingredients=[
            IngredientLine(id=f"i{n}", component=component, text=text)
            for n, (component, text) in enumerate(ingredients, 1)
        ],
        steps=[Step(id=f"s{n}", text=step) for n, step in enumerate(steps, 1)],
        recipe_yield=_yield(data.get("recipeYield")),
        stated_times=StatedTimes(
            prep=_stated_time(data.get("prepTime")),
            cook=_stated_time(data.get("cookTime")),
            total=_stated_time(data.get("totalTime")),
        ),
    )


def _optional(field: Callable[[], object]) -> str | None:
    try:
        value = field()
    except Exception:
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
