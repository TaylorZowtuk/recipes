"""The fallback chain's fetcher: a page loaded in headless Chromium, as Plateful, under the same
fetch policy as the plain fetch. Only the local CLI uses it, so the API never imports this.

Playwright's routes fire only for the first request of a redirect chain, so they can't check a
hop. Chrome's Fetch domain pauses every request, each hop included, before it leaves the browser,
so every check happens there, and the request goes out through Chromium's own network stack.
"""

from contextlib import suppress
from math import ceil
from time import monotonic
from typing import TYPE_CHECKING, Any, Self, cast

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

from recipes.ingest import (
    MAX_PAGE_BYTES,
    MAX_REDIRECTS,
    USER_AGENT,
    IngestFailed,
    PoliteFetcher,
    RenderedPage,
    raise_for_page_status,
)

if TYPE_CHECKING:
    from collections.abc import Callable
    from types import TracebackType

    from playwright.sync_api import BrowserContext, CDPSession, Page

    from recipes.ingest import Robots

# The whole fetch: robots.txt, every hop, and the page's scripts. Longer than the plain fetch's,
# since it has no API limit to fit inside and a page's scripts take time. Scripts get SETTLE_SECONDS
# of it to go quiet, and a page that never does is read as it stands.
DEADLINE_SECONDS = 30
SETTLE_SECONDS = 5
# Chrome's names for what a page doesn't need to be read.
UNNEEDED_RESOURCES = {"Image", "Media", "Font"}
# Ways out of the page that Chrome's Fetch domain never sees. Workers go too, because a worker could
# open any of the others from a scope this script doesn't run in.
UNCHECKABLE_APIS = """
for (const name of [
  "WebSocket", "WebTransport", "RTCPeerConnection", "webkitRTCPeerConnection", "Worker",
  "SharedWorker",
]) delete globalThis[name];
"""
READ_PAGE = "html => [html.outerHTML, document.body?.innerText ?? '']"


class _Guard:
    """Decides each request Chromium is about to send. A page and its navigations must be public
    and allowed by robots.txt, and stop the fetch if not. Any other request need only be public,
    and is dropped if not. Frames are dropped: they run out of sight of this session, and
    a recipe isn't read from one.
    """

    def __init__(self, polite: PoliteFetcher, cdp: CDPSession, deadline: float) -> None:
        self.polite = polite
        self.send = cast("Callable[..., dict[str, Any]]", cdp.send)  # pyright: ignore[reportUnknownMemberType]
        self.deadline = deadline
        self.robots: Robots = {}
        self.navigations = 0
        self.stopped: IngestFailed | None = None
        self.main_frame: str = self.send("Page.getFrameTree")["frameTree"]["frame"]["id"]
        cdp.on("Fetch.requestPaused", self._paused)
        self.send("Fetch.enable", {"patterns": [{"urlPattern": "*"}]})

    def _paused(self, event: dict[str, Any]) -> None:
        request_id = event["requestId"]
        url, kind, frame = event["request"]["url"], event["resourceType"], event["frameId"]
        # A request the page has since cancelled can no longer be answered.
        with suppress(PlaywrightError):
            if self._allows(url, kind, frame):
                self.send("Fetch.continueRequest", {"requestId": request_id})
            else:
                self.send(
                    "Fetch.failRequest", {"requestId": request_id, "errorReason": "BlockedByClient"}
                )

    def _allows(self, url: str, kind: str, frame: str) -> bool:
        if kind in UNNEEDED_RESOURCES or (kind == "Document" and frame != self.main_frame):
            return False
        try:
            if kind == "Document":
                self._check_navigation(url)
            else:
                self.polite.refuse_unless_public(url)
        except IngestFailed as failed:
            if kind == "Document":
                self.stopped = self.stopped or failed
            return False
        return True

    def _check_navigation(self, url: str) -> None:
        self.navigations += 1
        if self.navigations > MAX_REDIRECTS + 1:
            raise IngestFailed(reason="unreachable")
        self.polite.refuse_unless_public(url)
        self.polite.refuse_unless_allowed(url, self.robots, self.deadline)


class BrowserFetcher:
    """Fetches a page as `Fetcher` does, running its scripts, each fetch in a fresh context of one
    browser. Use it as a context manager. Raises PageNotFound, or IngestFailed for why not.
    """

    def __init__(self, polite: PoliteFetcher | None = None) -> None:
        self.polite = polite or PoliteFetcher()

    def __enter__(self) -> Self:
        self.playwright = sync_playwright().start()
        self.browser = self.playwright.chromium.launch()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.browser.close()
        self.playwright.stop()

    def __call__(self, url: str) -> RenderedPage:
        deadline = monotonic() + DEADLINE_SECONDS
        context = self.browser.new_context(
            user_agent=USER_AGENT, service_workers="block", accept_downloads=False
        )
        try:
            return self._load(context, url, deadline)
        finally:
            context.close()

    def _load(self, context: BrowserContext, url: str, deadline: float) -> RenderedPage:
        context.add_init_script(UNCHECKABLE_APIS)
        # A popup is a page of its own, out of the guard's sight, so only this page's requests pass.
        context.route("**/*", lambda route: route.abort())
        page = context.new_page()
        page.route("**/*", lambda route: route.continue_())
        guard = _Guard(self.polite, context.new_cdp_session(page), deadline)
        try:
            response = page.goto(url, wait_until="domcontentloaded", timeout=_ms_left(deadline))
            if response is not None:
                raise_for_page_status(response.status, page.url)
            _settle(page, deadline)
            html, text = _read(page, deadline)
        except PlaywrightError:
            raise guard.stopped or IngestFailed(reason="unreachable") from None
        if guard.stopped:
            raise guard.stopped
        if len(html.encode()) > MAX_PAGE_BYTES:
            raise IngestFailed(reason="unreachable")
        return RenderedPage(html=html, url=page.url, text=text)


def _settle(page: Page, deadline: float) -> None:
    """Give the page's scripts a moment to finish fetching and writing the recipe."""
    with suppress(PlaywrightTimeout):
        page.wait_for_load_state(
            "networkidle", timeout=min(SETTLE_SECONDS * 1000, _ms_left(deadline))
        )


def _read(page: Page, deadline: float) -> tuple[str, str]:
    """The page's HTML and visible text. A locator, because only its evaluate has a timeout, and
    a page's script can hang forever.
    """
    read = page.locator("html").evaluate(READ_PAGE, timeout=_ms_left(deadline))
    return cast("tuple[str, str]", tuple(read))


def _ms_left(deadline: float) -> int:
    """The time left as Playwright takes a timeout, where 0 would mean none."""
    left = ceil((deadline - monotonic()) * 1000)
    if left <= 0:
        raise IngestFailed(reason="unreachable")
    return left
