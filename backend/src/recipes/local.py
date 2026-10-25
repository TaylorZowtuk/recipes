"""The API on a fake stack: moto's DynamoDB and images bucket, bootstrapped and loaded with the
synthetic seed, a fake sign-in that needs neither SSM nor Google, and a fake web that never leaves
the machine. It serves the bucket's images at `/images/*`, as CloudFront does on a stack.

Importing this module starts an empty fake, so under `uvicorn --reload` every restart begins
from the same seeded Collection.
"""

import asyncio
import base64
import hashlib
import json
import os
from typing import TYPE_CHECKING, cast
from urllib.parse import urlsplit

import boto3
from moto import mock_aws

from recipes import seed
from recipes.api import create_app
from recipes.auth import Auth, AuthSettings, Claims, InvalidIdToken
from recipes.dev import dev_images
from recipes.images import ImageStore
from recipes.ingest import FetchRefused, IngestFailed, Page, PageNotFound
from recipes.store import Store, create_table

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from fastapi import Request, Response
    from types_boto3_s3.literals import BucketLocationConstraintType

TABLE_NAME = "plateful-local"
IMAGES_BUCKET = "plateful-local-images"
EDITOR = "editor@example.com"
GOOGLE_CLIENT_ID = "local-dev-client"
SERVICE_TOKEN = "local-dev-service-token"

os.environ.setdefault("AWS_DEFAULT_REGION", "us-west-2")


def seeded_store(images: ImageStore) -> Store:
    """The fake table, bootstrapped and seeded, with the seed's photos in the fake bucket.
    Adding a recipe bumps `META#collection`, so the bootstrap comes first; the API's own start
    then finds the table at its schema version.
    """
    store = Store(TABLE_NAME)
    store.bootstrap()
    seed.load(store, images)
    return store


def fake_verifier(token: str, audience: str) -> Claims:
    """Stands in for Google: `fake:<email>` is a verified email, `fake-unverified:<email>` isn't."""
    kind, _, email = token.partition(":")
    if audience != GOOGLE_CLIENT_ID or kind not in {"fake", "fake-unverified"} or not email:
        raise InvalidIdToken(token)
    return Claims(email=email, email_verified=kind == "fake")


FAKE_SETTINGS = AuthSettings.parse(
    {
        "editor-allowlist": EDITOR,
        "session-hmac-key": base64.b64encode(b"plateful-local-dev-session-key!!").decode(),
        "service-token-hash": hashlib.sha256(SERVICE_TOKEN.encode()).hexdigest(),
        "google-client-id": GOOGLE_CLIENT_ID,
    }
)


def fake_auth() -> Auth:
    """Sign-in for `make dev` and the local end-to-end tests. Its cookie isn't Secure, because
    WebKit drops Secure cookies from http://localhost and http://127.0.0.1 (Chromium keeps them).
    """
    return Auth(settings=lambda: FAKE_SETTINGS, verifier=fake_verifier, secure_cookie=False)


FAKE_HOST = "plateful.test"


class FakeWebsite:
    """Stands in for the web. On https://plateful.test, a path is a synthetic recipe page titled
    after its last segment, unless its first segment is one of these, for any rest of the path:

    - `/missing/…`: 404, so nothing is stored;
    - `/blocked/…`: 403, a waiting Queued Ingest;
    - `/robots-denied/…`: robots.txt refuses it, a Queued Ingest that needs the page;
    - `/no-recipe/…`: a page without a recipe, a waiting Queued Ingest.

    A recipe page's three candidate photos are generated placeholders under `/photos/`, and
    `/photos/missing/…` is a 404. Every other host is unreachable, so it waits too. Each Source
    is ingested once, so tests use a fresh path each time.
    """

    def __call__(self, url: str) -> Page:
        segments = _segments(url)
        match segments[0]:
            case "missing":
                raise PageNotFound(url)
            case "blocked":
                raise IngestFailed(reason="blocked")
            case "robots-denied":
                raise FetchRefused(reason="robots")
            case "no-recipe":
                html = "<!doctype html><html><head><title>About</title></head><body></body></html>"
            case _:
                html = _recipe_page(segments[-1])
        return Page(html=html, url=url)

    def photo(self, url: str) -> bytes:
        segments = _segments(url)
        if segments[0] != "photos" or segments[1:2] == ["missing"]:
            raise PageNotFound(url)
        name = segments[-1].removesuffix(".png")
        hue = int(hashlib.sha256(name.encode()).hexdigest(), 16) % 360
        width, height = PHOTO_SIZES[next((s for s in PHOTO_SIZES if name.endswith(s)), "")]
        return seed.placeholder_photo(f"hsl({hue}, 45%, 50%)", width=width, height=height)


# A candidate photo's size, by the end of its name.
PHOTO_SIZES = {"-square": (800, 800), "-wide": (1600, 900), "": (1200, 800)}


def _segments(url: str) -> list[str]:
    parts = urlsplit(url)
    if parts.hostname != FAKE_HOST:
        raise IngestFailed(reason="unreachable")
    return [s for s in parts.path.split("/") if s] or ["home"]


def _recipe_page(slug: str) -> str:
    title = slug.replace("-", " ").title()
    recipe = {
        "@context": "https://schema.org",
        "@type": "Recipe",
        "name": title,
        "description": f"A synthetic recipe for {title}, written for the fake stack.",
        "author": {"@type": "Person", "name": "Fake Kitchen Cook"},
        "image": [
            f"https://{FAKE_HOST}/photos/{slug}.png",
            {"@type": "ImageObject", "url": f"/photos/{slug}-square.png"},
        ],
        "recipeYield": "Serves 4",
        "prepTime": "PT15M",
        "cookTime": "about 30 minutes",
        "totalTime": "PT45M",
        "recipeIngredient": ["2 cups cooked rice", "1 tbsp olive oil", "1 tsp kosher salt"],
        "recipeInstructions": [
            {"@type": "HowToStep", "text": "Warm the oil in a pan."},
            {"@type": "HowToStep", "text": "Add the rice and salt, and stir until hot."},
        ],
    }
    return (
        '<!doctype html><html><head><meta charset="utf-8">'
        '<meta property="og:site_name" content="Plateful Test Kitchen">'
        f'<meta property="og:image" content="/photos/{slug}-wide.png">'
        f'<script type="application/ld+json">{json.dumps(recipe)}</script>'
        "</head><body></body></html>"
    )


mock_aws().start()
create_table(boto3.client("dynamodb"), TABLE_NAME)
images = ImageStore(IMAGES_BUCKET)
region = cast("BucketLocationConstraintType", os.environ["AWS_DEFAULT_REGION"])
images.client.create_bucket(
    Bucket=IMAGES_BUCKET, CreateBucketConfiguration={"LocationConstraint": region}
)
app = create_app(
    store=lambda: seeded_store(images),
    auth=fake_auth,
    fetcher=FakeWebsite,
    images=lambda: images,
)
app.include_router(dev_images)


# moto's table isn't safe across the threads uvicorn runs routes on: overlapping transactions
# fail with a 500. One request at a time, as if on one table.
one_at_a_time = asyncio.Lock()


@app.middleware("http")
async def _serialised(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    async with one_at_a_time:
        return await call_next(request)
