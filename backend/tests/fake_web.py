"""A fake web for the polite fetcher: a requests adapter serving canned pages."""

import gzip
import io
import ipaddress
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, NamedTuple

import requests
from requests.adapters import HTTPAdapter
from urllib3.response import HTTPResponse

from recipes.ingest import PoliteFetcher, UnredirectedSession

if TYPE_CHECKING:
    from collections.abc import Mapping

PAGES = Path(__file__).parent / "pages"
# What every named host resolves to: any address on the public internet, since nothing connects.
PUBLIC_ADDRESS = "8.8.8.8"


class Redirect(NamedTuple):
    """A redirect to `location`, which may be relative, with a `body` the fetcher shouldn't read."""

    location: str
    status: int = 301
    body: str = ""


class Served(NamedTuple):
    """A body sent with `content_type`, all at once or, dripping, one byte per read, and
    compressed when it has an `encoding`.
    """

    status: int
    body: str | bytes
    content_type: str = "text/html; charset=utf-8"
    drip: bool = False
    encoding: Literal["gzip"] | None = None


# A page as its status and body, a redirect, or the error fetching it raises.
type Page = tuple[int, str] | Served | Redirect | requests.RequestException


class _Body(io.BytesIO):
    """A body that counts the bytes read from it."""

    read_bytes = 0

    def read(self, size: int | None = -1, /) -> bytes:
        data = super().read(size)
        self.read_bytes += len(data)
        return data

    def read1(self, size: int | None = -1, /) -> bytes:
        data = super().read1(size)
        self.read_bytes += len(data)
        return data


class _Drip(_Body):
    def read1(self, size: int | None = -1, /) -> bytes:
        return super().read1(1 if size else size)


def page(name: str) -> str:
    """A synthetic page from tests/pages."""
    return (PAGES / name).read_text()


class FakeWeb(HTTPAdapter):
    """Serves `pages` by URL, and 404 for any other, recording every request it's sent and the
    body it answered with.
    """

    def __init__(self, pages: Mapping[str, Page] | None = None) -> None:
        super().__init__()
        self.pages = dict(pages or {})
        self.requests: list[requests.PreparedRequest] = []
        self.timeouts: list[object] = []
        self.bodies: list[_Body] = []

    @property
    def urls(self) -> list[str | None]:
        return [request.url for request in self.requests]

    def send(  # pyright: ignore[reportIncompatibleMethodOverride]
        self, request: requests.PreparedRequest, **kwargs: Any
    ) -> requests.Response:
        self.requests.append(request)
        self.timeouts.append(kwargs.get("timeout"))
        served = self.pages.get(request.url or "", (404, "Not found"))
        if isinstance(served, requests.RequestException):
            raise served
        headers: dict[str, str] = {}
        if isinstance(served, Redirect):
            headers["Location"] = served.location
            served = Served(served.status, served.body)
        elif not isinstance(served, Served):
            served = Served(*served)
        headers["Content-Type"] = served.content_type
        body = served.body.encode() if isinstance(served.body, str) else served.body
        if served.encoding:
            headers["Content-Encoding"] = served.encoding
            body = gzip.compress(body)
        self.bodies.append((_Drip if served.drip else _Body)(body))
        raw = HTTPResponse(
            body=self.bodies[-1],
            headers=headers,
            status=served.status,
            preload_content=False,
        )
        return self.build_response(request, raw)

    def session(self) -> UnredirectedSession:
        """A session whose every request goes to this fake web, leaving redirects to the fetcher
        as the fetcher's own session does.
        """
        session = UnredirectedSession()
        session.mount("http://", self)
        session.mount("https://", self)
        return session

    @staticmethod
    def resolve(host: str) -> list[str]:
        """An address literal as itself, and any name as a public address."""
        try:
            return [str(ipaddress.ip_address(host))]
        except ValueError:
            return [PUBLIC_ADDRESS]

    def fetcher(self) -> PoliteFetcher:
        """The polite fetcher, on this fake web."""
        return PoliteFetcher(self.session(), resolve=self.resolve)
