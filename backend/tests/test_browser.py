"""The browser fetcher in real Chromium against real local HTTP servers, because how Chromium and
Playwright treat a redirect is what these tests prove. `localhost` counts as a public host, through
the fake web's resolver, and 127.0.0.1 as what it is.
"""

import json
import threading
from base64 import b64encode
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from time import monotonic
from typing import TYPE_CHECKING

import pytest
from fake_web import FakeWeb, page
from test_enrich import BASE_URL, api, through
from test_fallback import only_recipe, queue

from recipes.browser import BrowserFetcher
from recipes.fallback import run
from recipes.ingest import (
    BROWSER_EXTRACTOR,
    MAX_PAGE_BYTES,
    USER_AGENT,
    FetchRefused,
    IngestFailed,
    PageNotFound,
    PoliteFetcher,
    parse,
)

if TYPE_CHECKING:
    from collections.abc import Iterator

    from fastapi.testclient import TestClient

    from recipes.store import Store

# One browser for the whole file, so its tests stay on one worker.
pytestmark = pytest.mark.xdist_group("browser")

HTML = "text/html; charset=utf-8"


@dataclass(frozen=True)
class Reply:
    status: int = 200
    body: str = ""
    content_type: str = HTML
    location: str | None = None


def redirect(location: str, status: int = 302) -> Reply:
    return Reply(status=status, location=location)


@dataclass
class Site:
    """A real HTTP server answering each path from `replies`, 404 otherwise. It records the path
    and user agent of each request it receives.
    """

    port: int = 0
    replies: dict[str, Reply] = field(default_factory=dict[str, Reply])
    seen: list[str] = field(default_factory=list[str])
    agents: list[str] = field(default_factory=list[str])

    @property
    def public(self) -> str:
        return f"http://localhost:{self.port}"

    @property
    def loopback(self) -> str:
        return f"http://127.0.0.1:{self.port}"


def serve(site: Site) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            site.seen.append(self.path)
            site.agents.append(self.headers.get("User-Agent", ""))
            reply = site.replies.get(self.path, Reply(status=404, body="Not found"))
            body = reply.body.encode()
            self.send_response(reply.status)
            if reply.location:
                self.send_header("Location", reply.location)
            self.send_header("Content-Type", reply.content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            pass  # the name is http.server's

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    site.port = server.server_port
    threading.Thread(target=server.serve_forever, args=(0.01,), daemon=True).start()
    return server


@pytest.fixture
def site() -> Iterator[Site]:
    site = Site()
    server = serve(site)
    yield site
    server.shutdown()
    server.server_close()


@pytest.fixture
def other_site() -> Iterator[Site]:
    site = Site()
    server = serve(site)
    yield site
    server.shutdown()
    server.server_close()


@pytest.fixture(scope="module")
def fetch() -> Iterator[BrowserFetcher]:
    with BrowserFetcher(PoliteFetcher(resolve=FakeWeb.resolve)) as fetcher:
        yield fetcher


def test_the_page_is_rendered_and_read_as_plateful(fetch: BrowserFetcher, site: Site) -> None:
    site.replies["/recipe"] = Reply(
        body="""<!doctype html><title>Late</title><body><p>Static words</p>
        <p style="display: none">Hidden words</p>
        <script>document.body.append("Rendered words")</script>"""
    )

    fetched = fetch(f"{site.public}/recipe")

    assert fetched.url == f"{site.public}/recipe"
    assert "Rendered words" in fetched.html
    assert "Static words" in fetched.text
    assert "Rendered words" in fetched.text
    assert "Hidden words" not in fetched.text
    assert "document.body" not in fetched.text
    assert set(site.agents) == {USER_AGENT}


def test_a_recipe_written_by_a_script_can_be_parsed(fetch: BrowserFetcher, site: Site) -> None:
    html = b64encode(page("json-ld-recipe.html").encode()).decode()
    site.replies["/recipe"] = Reply(
        body=f'<script>document.documentElement.innerHTML = atob("{html}")</script>'
    )

    fetched = fetch(f"{site.public}/recipe")

    assert parse(fetched.html, fetched.url).original.title == "Weeknight Miso Soup"


def test_a_queued_ingest_is_saved_from_a_page_real_chromium_rendered(
    editor_client: TestClient, api_store: Store, fetch: BrowserFetcher, site: Site
) -> None:
    recipe = """{"@context": "https://schema.org", "@type": "Recipe", "name": "Script Stew",
    "recipeIngredient": ["1 turnip"], "recipeInstructions": "Stew the turnip."}"""
    site.replies["/stew"] = Reply(
        body=f"""<script>
        const data = document.createElement("script");
        data.type = "application/ld+json";
        data.text = {json.dumps(recipe)};
        document.head.append(data);
        </script>"""
    )
    queue(api_store, "stew", site=site.public)

    assert run(BASE_URL, through(api(editor_client)), fetch) == 0

    assert only_recipe(editor_client)["original"]["title"] == "Script Stew"
    assert only_recipe(editor_client)["original"]["extractor"] == BROWSER_EXTRACTOR


def test_every_server_redirect_hop_is_checked_on_its_own_hosts_robots(
    fetch: BrowserFetcher, site: Site, other_site: Site
) -> None:
    site.replies["/start"] = redirect(f"{other_site.public}/hop")
    other_site.replies["/hop"] = redirect("/recipe", 301)
    other_site.replies["/recipe"] = Reply(body="<body>Arrived</body>")

    fetched = fetch(f"{site.public}/start")

    assert fetched.url == f"{other_site.public}/recipe"
    assert "Arrived" in fetched.text
    assert site.seen == ["/robots.txt", "/start"]
    assert other_site.seen == ["/robots.txt", "/hop", "/recipe"]


def test_a_redirect_hop_robots_refuses_is_never_requested(
    fetch: BrowserFetcher, site: Site, other_site: Site
) -> None:
    site.replies["/start"] = redirect(f"{other_site.public}/hop")
    other_site.replies["/robots.txt"] = Reply(
        body="User-agent: *\nDisallow: /recipe\n", content_type="text/plain"
    )
    other_site.replies["/hop"] = redirect("/recipe")

    with pytest.raises(FetchRefused) as refused:
        fetch(f"{site.public}/start")

    assert refused.value.reason == "robots"
    assert other_site.seen == ["/robots.txt", "/hop"]


def test_the_first_page_robots_refuses_is_never_requested(
    fetch: BrowserFetcher, site: Site
) -> None:
    site.replies["/robots.txt"] = Reply(
        body="User-agent: Plateful\nDisallow: /\n", content_type="text/plain"
    )

    with pytest.raises(FetchRefused) as refused:
        fetch(f"{site.public}/recipe")

    assert refused.value.reason == "robots"
    assert site.seen == ["/robots.txt"]


@pytest.mark.parametrize(
    "navigation",
    ['<script>location = "/denied"</script>', '<meta http-equiv="refresh" content="0; /denied">'],
)
def test_a_script_navigation_robots_refuses_is_never_requested(
    fetch: BrowserFetcher, site: Site, navigation: str
) -> None:
    site.replies["/robots.txt"] = Reply(
        body="User-agent: *\nDisallow: /denied\n", content_type="text/plain"
    )
    site.replies["/recipe"] = Reply(body=navigation)

    with pytest.raises(FetchRefused) as refused:
        fetch(f"{site.public}/recipe")

    assert refused.value.reason == "robots"
    assert "/denied" not in site.seen


def test_a_script_navigation_robots_allows_is_followed(fetch: BrowserFetcher, site: Site) -> None:
    site.replies["/recipe"] = Reply(body='<script>location = "/moved"</script>')
    site.replies["/moved"] = Reply(body="<body>Moved here</body>")

    fetched = fetch(f"{site.public}/recipe")

    assert fetched.url == f"{site.public}/moved"
    assert "Moved here" in fetched.text


def test_robots_does_not_apply_to_subresources(fetch: BrowserFetcher, site: Site) -> None:
    site.replies["/robots.txt"] = Reply(
        body="User-agent: *\nDisallow: /assets/\n", content_type="text/plain"
    )
    site.replies["/recipe"] = Reply(body='<body><script src="/assets/app.js"></script></body>')
    site.replies["/assets/app.js"] = Reply(
        body='document.body.append("Script ran")', content_type="text/javascript"
    )

    assert "Script ran" in fetch(f"{site.public}/recipe").text


def test_images_media_and_fonts_are_not_requested(fetch: BrowserFetcher, site: Site) -> None:
    site.replies["/recipe"] = Reply(
        body="""<style>
        @font-face { font-family: F; src: url(/font.woff2) }
        body { font-family: F }
        </style><body>Words<img src="/photo.png"><video src="/clip.mp4" autoplay></video></body>"""
    )

    fetch(f"{site.public}/recipe")

    assert site.seen == ["/robots.txt", "/recipe"]


def test_a_redirect_off_the_public_web_is_refused_before_it_is_requested(
    fetch: BrowserFetcher, site: Site
) -> None:
    site.replies["/start"] = redirect(f"{site.loopback}/secret")

    with pytest.raises(FetchRefused) as refused:
        fetch(f"{site.public}/start")

    assert refused.value.reason == "blocked"
    assert "/secret" not in site.seen


def test_subresources_never_reach_a_non_public_address(
    fetch: BrowserFetcher, site: Site, other_site: Site
) -> None:
    """Direct, through a subresource's own redirect, and by every other way out of a page."""
    private = other_site.loopback
    site.replies["/bounce.js"] = redirect(f"{private}/bounced.js")
    site.replies["/recipe"] = Reply(
        body=f"""<body>Still read</body>
        <script src="{private}/direct.js"></script>
        <script src="/bounce.js"></script>
        <script>
          fetch("{private}/fetched", {{ mode: "no-cors" }}).catch(() => {{}});
          fetch("/bounce.js", {{ mode: "no-cors" }}).catch(() => {{}});
          navigator.sendBeacon("{private}/beacon");
          const inner = document.body.appendChild(document.createElement("iframe")).contentWindow;
          document.body.append(typeof WebSocket, typeof Worker, typeof RTCPeerConnection);
          document.body.append(typeof inner.WebSocket);
        </script>"""
    )

    fetched = fetch(f"{site.public}/recipe")

    assert "Still read" in fetched.text
    assert "undefinedundefinedundefinedundefined" in fetched.text
    assert other_site.seen == []


def test_frames_popups_and_service_workers_are_not_loaded(
    fetch: BrowserFetcher, site: Site
) -> None:
    site.replies["/recipe"] = Reply(
        body="""<body>Words</body><iframe src="/frame"></iframe><script>
        window.open("/popup");
        navigator.serviceWorker?.register("/sw.js").catch(() => {});
        </script>"""
    )
    site.replies["/sw.js"] = Reply(body="", content_type="text/javascript")

    fetch(f"{site.public}/recipe")

    assert site.seen == ["/robots.txt", "/recipe"]


@pytest.mark.parametrize("status", [404, 410])
def test_a_page_that_is_not_there_is_not_found(
    fetch: BrowserFetcher, site: Site, status: int
) -> None:
    site.replies["/gone"] = Reply(status=status, body="<body>Gone</body>")

    with pytest.raises(PageNotFound):
        fetch(f"{site.public}/gone")


@pytest.mark.parametrize(
    ("status", "reason"),
    [(403, "blocked"), (429, "rate_limited"), (503, "server_error")],
)
def test_other_failures_give_their_reason(
    fetch: BrowserFetcher, site: Site, status: int, reason: str
) -> None:
    site.replies["/page"] = Reply(status=status, body="<body>No</body>")

    with pytest.raises(IngestFailed) as failed:
        fetch(f"{site.public}/page")

    assert failed.value.reason == reason


def test_a_server_error_on_robots_stops_the_fetch(fetch: BrowserFetcher, site: Site) -> None:
    site.replies["/robots.txt"] = Reply(status=503)

    with pytest.raises(IngestFailed) as failed:
        fetch(f"{site.public}/recipe")

    assert failed.value.reason == "server_error"
    assert site.seen == ["/robots.txt"]


def test_a_page_past_the_size_limit_is_unreachable(fetch: BrowserFetcher, site: Site) -> None:
    site.replies["/huge"] = Reply(body=f"<body>{'x' * (MAX_PAGE_BYTES + 1)}</body>")

    with pytest.raises(IngestFailed) as failed:
        fetch(f"{site.public}/huge")

    assert failed.value.reason == "unreachable"


def test_a_page_that_grows_past_the_size_limit_is_unreachable(
    fetch: BrowserFetcher, site: Site
) -> None:
    site.replies["/grows"] = Reply(
        body=f'<body><script>document.body.append("x".repeat({MAX_PAGE_BYTES + 1}))</script>'
    )

    with pytest.raises(IngestFailed) as failed:
        fetch(f"{site.public}/grows")

    assert failed.value.reason == "unreachable"


def test_too_many_navigations_are_unreachable(fetch: BrowserFetcher, site: Site) -> None:
    for hop in range(10):
        site.replies[f"/{hop}"] = redirect(f"/{hop + 1}")

    with pytest.raises(IngestFailed) as failed:
        fetch(f"{site.public}/0")

    assert failed.value.reason == "unreachable"
    assert "/6" not in site.seen


def test_a_host_nothing_listens_on_is_unreachable(fetch: BrowserFetcher, site: Site) -> None:
    site.replies["/start"] = redirect("http://localhost:1/recipe")

    with pytest.raises(IngestFailed) as failed:
        fetch(f"{site.public}/start")

    assert failed.value.reason == "unreachable"


@pytest.mark.parametrize(
    "script",
    ["while (true);", "setTimeout(() => { while (true); }, 10)"],
)
def test_a_page_that_hangs_is_given_up_on_at_the_deadline(
    fetch: BrowserFetcher, site: Site, monkeypatch: pytest.MonkeyPatch, script: str
) -> None:
    monkeypatch.setattr("recipes.browser.DEADLINE_SECONDS", 1.5)
    site.replies["/hang"] = Reply(body=f"<body>Words<script>{script}</script></body>")
    started = monotonic()

    with pytest.raises(IngestFailed) as failed:
        fetch(f"{site.public}/hang")

    assert failed.value.reason == "unreachable"
    assert monotonic() - started < 4
