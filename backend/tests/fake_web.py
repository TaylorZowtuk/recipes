"""A fake web for the polite fetcher: a requests adapter serving canned pages."""

import io
from pathlib import Path
from typing import TYPE_CHECKING, Any, NamedTuple

import requests
from requests.adapters import HTTPAdapter
from urllib3.response import HTTPResponse

if TYPE_CHECKING:
    from collections.abc import Mapping

PAGES = Path(__file__).parent / "pages"


class Redirect(NamedTuple):
    """A redirect to `location`, which may be relative."""

    location: str
    status: int = 301


# A page as its status and body, a redirect, or the error fetching it raises.
type Page = tuple[int, str] | Redirect | requests.RequestException


def page(name: str) -> str:
    """A synthetic page from tests/pages."""
    return (PAGES / name).read_text()


class FakeWeb(HTTPAdapter):
    """Serves `pages` by URL, and 404 for any other, recording every request it's sent."""

    def __init__(self, pages: Mapping[str, Page] | None = None) -> None:
        super().__init__()
        self.pages = dict(pages or {})
        self.requests: list[requests.PreparedRequest] = []
        self.timeouts: list[object] = []

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
        headers = {"Content-Type": "text/html; charset=utf-8"}
        if isinstance(served, Redirect):
            status, body = served.status, ""
            headers["Location"] = served.location
        else:
            status, body = served
        raw = HTTPResponse(
            body=io.BytesIO(body.encode()),
            headers=headers,
            status=status,
            preload_content=False,
        )
        return self.build_response(request, raw)

    def session(self) -> requests.Session:
        """A session whose every request goes to this fake web."""
        session = requests.Session()
        session.mount("http://", self)
        session.mount("https://", self)
        return session
