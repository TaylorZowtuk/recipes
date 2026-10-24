"""The API on a fake stack: moto's DynamoDB, bootstrapped and loaded with the synthetic seed, a
fake sign-in that needs neither SSM nor Google, and a fake web that never leaves the machine.

Importing this module starts an empty fake, so under `uvicorn --reload` every restart begins
from the same seeded Collection.
"""

import base64
import hashlib
import json
import os
from urllib.parse import urlsplit

import boto3
from moto import mock_aws

from recipes import seed
from recipes.api import create_app
from recipes.auth import Auth, AuthSettings, Claims, InvalidIdToken
from recipes.ingest import FetchRefused, IngestFailed, Page, PageNotFound
from recipes.store import Store, create_table

TABLE_NAME = "plateful-local"
EDITOR = "editor@example.com"
GOOGLE_CLIENT_ID = "local-dev-client"
SERVICE_TOKEN = "local-dev-service-token"

os.environ.setdefault("AWS_DEFAULT_REGION", "us-west-2")


def seeded_store() -> Store:
    """The fake table, bootstrapped and seeded. Adding a recipe bumps `META#collection`, so the
    bootstrap comes first; the API's own start then finds the table at its schema version.
    """
    store = Store(TABLE_NAME)
    store.bootstrap()
    seed.load(store)
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


def fake_fetcher(url: str) -> Page:
    """Stands in for the web. On https://plateful.test, a path is a synthetic recipe page titled
    after its last segment, unless its first segment is one of these, for any rest of the path:

    - `/missing/…`: 404, so nothing is stored;
    - `/blocked/…`: 403, a waiting Queued Ingest;
    - `/robots-denied/…`: robots.txt refuses it, a Queued Ingest that needs the page;
    - `/no-recipe/…`: a page without a recipe, a waiting Queued Ingest.

    Every other host is unreachable, so it waits too. Each Source is ingested once, so tests
    use a fresh path each time.
    """
    parts = urlsplit(url)
    if parts.hostname != FAKE_HOST:
        raise IngestFailed(reason="unreachable")
    segments = [s for s in parts.path.split("/") if s] or ["home"]
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
            html = _recipe_page(segments[-1].replace("-", " ").title())
    return Page(html=html, url=url)


def _recipe_page(title: str) -> str:
    recipe = {
        "@context": "https://schema.org",
        "@type": "Recipe",
        "name": title,
        "description": f"A synthetic recipe for {title}, written for the fake stack.",
        "author": {"@type": "Person", "name": "Fake Kitchen Cook"},
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
        f'<script type="application/ld+json">{json.dumps(recipe)}</script>'
        "</head><body></body></html>"
    )


mock_aws().start()
create_table(boto3.client("dynamodb"), TABLE_NAME)
app = create_app(store=seeded_store, auth=fake_auth, fetcher=lambda: fake_fetcher)
