"""Ingest from a website: a Source's dedupe key, a polite fetch, and the parse into an Original
and its candidate photos.

Only the Original is kept. The page's HTML and its schema.org data are read here and dropped.
"""

import ipaddress
import re
import socket
from dataclasses import dataclass
from http import HTTPStatus
from time import monotonic
from typing import TYPE_CHECKING, Protocol, cast, override
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit

import requests
import urllib3
from protego import Protego

from recipes.models import (
    MAX_KEY_BYTES,
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

# What captured an Original: a plain fetch, a page an editor pasted, the CLI's browser, or its LLM.
EXTRACTOR = "recipe-scrapers"
PASTED_EXTRACTOR = "pasted-page"
BROWSER_EXTRACTOR = "playwright+recipe-scrapers"
LLM_EXTRACTOR = "llm"
ROBOTS_AGENT = "Plateful"
USER_AGENT = f"{ROBOTS_AGENT}/1 (+https://github.com/TaylorZowtuk/recipes)"
# Per request, and a deadline for the whole fetch, bodies included, so robots.txt, a page and its
# redirects still answer inside the API's 30 s: a body read started just before the deadline ends
# by about 22 s (one 8 s read). DNS lookups have no timeout, and the connect timeout is per
# address the host resolves to, so neither is bounded. Running out of time, of redirects, or of
# the size a body may decode to, is unreachable.
CONNECT_SECONDS = 3
TIMEOUT_SECONDS = 8
DEADLINE_SECONDS = 14
MAX_REDIRECTS = 5
MAX_PAGE_BYTES = 2 * 1024 * 1024
MAX_ROBOTS_BYTES = 512 * 1024
MAX_PHOTO_BYTES = 10 * 1024 * 1024
CHUNK_BYTES = 64 * 1024
# The review shows at most this many of a page's photos to choose from.
MAX_CANDIDATE_PHOTOS = 8

# Query parameters that only say how someone reached the page. Any other, `ref` included, is kept.
TRACKING = {"fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "_ga", "igshid"}
DEFAULT_PORTS = {"http": 80, "https": 443}


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


class TooLarge(Exception):
    """A body that decodes to more than its size limit. A page past it is unreachable."""


# Dedupe keys


def website_dedupe_key(url: str) -> str:
    """The normalised URL: https, lower-case host without `www.`, no default port, fragment,
    trailing slash or tracking parameters, and the other parameters sorted. Path case is kept.
    """
    try:
        parts = urlsplit(url.strip())
        port = parts.port
    except ValueError:
        raise InvalidUrl(url) from None
    scheme = parts.scheme.lower()
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


# Fetching


@dataclass(frozen=True)
class Page:
    html: str
    url: str  # where the page finally came from, after any redirects


@dataclass(frozen=True)
class RenderedPage(Page):
    text: str  # what a reader of the page sees, without its markup


class Fetcher(Protocol):
    def __call__(self, url: str) -> Page:
        """The page. Raises PageNotFound, or IngestFailed for a Queued Ingest."""
        ...

    def photo(self, url: str) -> bytes:
        """The photo's bytes, fetched as politely. Raises PageNotFound, IngestFailed or TooLarge."""
        ...


# Each origin's robots.txt read so far in one fetch, None when it has none.
type Robots = dict[str, Protego | None]


class UnredirectedSession(requests.Session):
    """A session that never resolves a redirect itself, as requests otherwise does even when not
    following one, reading the whole 3xx body unbounded. The fetcher follows them by hand.
    """

    @override
    def get_redirect_target(self, resp: requests.Response) -> None:
        return None


def resolve(host: str) -> list[str]:
    """The addresses `host` resolves to."""
    return [str(info[4][0]) for info in socket.getaddrinfo(host, None)]


class PoliteFetcher:
    """Fetches a page or a photo as Plateful, each request once, following a redirect only where the
    robots.txt of the host it leads to allows it, and only to a host on the public internet.
    """

    def __init__(
        self,
        session: UnredirectedSession | None = None,
        resolve: Callable[[str], list[str]] = resolve,
    ) -> None:
        self.session = session or UnredirectedSession()
        self.session.headers["User-Agent"] = USER_AGENT
        self.resolve = resolve

    def __call__(self, url: str) -> Page:
        deadline = monotonic() + DEADLINE_SECONDS
        url, response = self._fetch(url, deadline)
        with response:
            return Page(html=_text(response, deadline, MAX_PAGE_BYTES), url=url)

    def photo(self, url: str) -> bytes:
        deadline = monotonic() + DEADLINE_SECONDS
        _, response = self._fetch(url, deadline)
        with response:
            return _body(response, deadline, MAX_PHOTO_BYTES)

    def _fetch(self, url: str, deadline: float) -> tuple[str, requests.Response]:
        """Where `url` finally leads, each hop allowed by its robots.txt, and its successful
        response, its body unread.
        """
        robots: Robots = {}
        url, response = self._follow(
            url, deadline, lambda hop: self.refuse_unless_allowed(hop, robots, deadline)
        )
        if response.status_code >= HTTPStatus.BAD_REQUEST:
            with response:
                raise_for_page_status(response.status_code, url)
        return url, response

    def _follow(
        self, url: str, deadline: float, check: Callable[[str], None]
    ) -> tuple[str, requests.Response]:
        """Where `url` finally leads and its response, following at most MAX_REDIRECTS by hand,
        so each hop is checked as public and by `check` before it's requested, and has its own
        timeout inside the deadline.
        """
        for _ in range(MAX_REDIRECTS + 1):
            self.refuse_unless_public(url)
            check(url)
            response = self._get(url, deadline)
            if not response.is_redirect:
                return url, response
            response.close()
            try:
                url = urljoin(url, response.headers["Location"])
            except ValueError:  # a malformed Location
                raise IngestFailed(reason="unreachable") from None
        # A redirect loop, like a page that never answers.
        raise IngestFailed(reason="unreachable")

    def refuse_unless_public(self, url: str) -> None:
        """Loopback, private and other non-global addresses are never fetched, so a pasted URL
        or a redirect can't reach the machine Plateful runs on or its network. The host checked
        is the one requests connects to, encoded as it encodes it (IDNA 2008).
        """
        try:
            prepared = requests.Request("GET", url).prepare().url or ""
            addresses = self.resolve(urlsplit(prepared).hostname or "")
        except OSError, UnicodeError, requests.RequestException:
            raise IngestFailed(reason="unreachable") from None
        if not all(ipaddress.ip_address(a.partition("%")[0]).is_global for a in addresses):
            raise FetchRefused(reason="blocked")

    def refuse_unless_allowed(self, url: str, robots: Robots, deadline: float) -> None:
        """Raises FetchRefused unless the robots.txt of `url`'s origin allows it, reading each
        origin's once into `robots`, which lasts one fetch.
        """
        parts = urlsplit(url)
        origin = urlunsplit((parts.scheme, parts.netloc, "", "", ""))
        if origin not in robots:
            robots[origin] = self._robots(f"{origin}/robots.txt", deadline)
        rules = robots[origin]
        if rules is not None and not rules.can_fetch(url, ROBOTS_AGENT):
            raise FetchRefused(reason="robots")

    def _robots(self, url: str, deadline: float) -> Protego | None:
        _, robots = self._follow(url, deadline, lambda _hop: None)
        with robots:
            # RFC 9309: a robots.txt that's unavailable (4xx) allows everything, and one that's
            # unreachable (5xx) disallows everything for now, so the Source waits.
            if HTTPStatus.BAD_REQUEST <= robots.status_code < HTTPStatus.INTERNAL_SERVER_ERROR:
                return None
            raise_for_status(robots.status_code)
            return Protego.parse(_text(robots, deadline, MAX_ROBOTS_BYTES))

    def _get(self, url: str, deadline: float) -> requests.Response:
        remaining = deadline - monotonic()
        if remaining <= 0:
            raise IngestFailed(reason="unreachable")
        timeout = (min(CONNECT_SECONDS, remaining), min(TIMEOUT_SECONDS, remaining))
        try:
            return self.session.get(url, timeout=timeout, allow_redirects=False, stream=True)
        except requests.RequestException:
            raise IngestFailed(reason="unreachable") from None


def raise_for_page_status(status: int, url: str) -> None:
    """What a page's final status means: not there (404 or 410), or why ingest stopped."""
    if status in {HTTPStatus.NOT_FOUND, HTTPStatus.GONE}:
        raise PageNotFound(url)
    raise_for_status(status)


def raise_for_status(status: int) -> None:
    if status == HTTPStatus.TOO_MANY_REQUESTS:
        raise IngestFailed(reason="rate_limited")
    if status >= HTTPStatus.INTERNAL_SERVER_ERROR:
        raise IngestFailed(reason="server_error")
    if status >= HTTPStatus.BAD_REQUEST:
        raise IngestFailed(reason="blocked")


def _body(response: requests.Response, deadline: float, max_bytes: int) -> bytes:
    """The body, read as it arrives, so one that drips past the deadline is given up on, and
    one that decodes to more than `max_bytes` is TooLarge. read1 returns whatever has arrived
    rather than waiting for a whole chunk.
    """
    body = bytearray()
    if monotonic() > deadline:
        raise IngestFailed(reason="unreachable")
    try:
        while chunk := response.raw.read1(CHUNK_BYTES, decode_content=True):
            body += chunk
            if len(body) > max_bytes:
                raise TooLarge
            if monotonic() > deadline:
                raise IngestFailed(reason="unreachable")
    except urllib3.exceptions.HTTPError, OSError:
        raise IngestFailed(reason="unreachable") from None
    return bytes(body)


def _text(response: requests.Response, deadline: float, max_bytes: int) -> str:
    """The body as text. Text past its size limit is unreachable, like a page that never ends."""
    try:
        body = _body(response, deadline, max_bytes)
    except TooLarge:
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
    candidate_photos: list[str]  # absolute http(s) URLs, in the page's order


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
    return Captured(
        original=original,
        site_name=site_name and site_name[:MAX_LABEL],
        candidate_photos=_candidate_photos(scraper, url),
    )


def _candidate_photos(scraper: AbstractScraper, url: str) -> list[str]:
    """The Recipe's `image` (a URL, an ImageObject or a list of either), then og:image, resolved
    against the page's URL. Only http(s) URLs short enough to be a WebUrl are kept, each once.
    """
    data = cast("dict[str, object]", scraper.schema.data)  # pyright: ignore[reportUnknownMemberType]
    image = data.get("image")
    found = cast("list[object]", image) if isinstance(image, list) else [image]
    found.append(_optional(scraper.opengraph.image))  # pyright: ignore[reportUnknownMemberType, reportUnknownArgumentType]
    urls = [cast("dict[str, object]", i).get("url") if isinstance(i, dict) else i for i in found]
    candidates: dict[str, None] = {}
    for item in urls:
        if not isinstance(item, str):
            continue
        try:
            absolute = urljoin(url, item.strip())
            parts = urlsplit(absolute)
        except ValueError:
            continue
        if (
            parts.scheme in DEFAULT_PORTS
            and parts.hostname
            and len(absolute) <= MAX_KEY_BYTES
            and not any(c.isspace() for c in absolute)
        ):
            candidates.setdefault(absolute, None)
    return list(candidates)[:MAX_CANDIDATE_PHOTOS]


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
