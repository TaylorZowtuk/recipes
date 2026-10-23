"""The API on a fake stack: moto's DynamoDB, bootstrapped and loaded with the synthetic seed, and
a fake sign-in that needs neither SSM nor Google.

Importing this module starts an empty fake, so under `uvicorn --reload` every restart begins
from the same seeded Collection.
"""

import base64
import hashlib
import os

import boto3
from moto import mock_aws

from recipes import seed
from recipes.api import create_app
from recipes.auth import Auth, AuthSettings, Claims, InvalidIdToken
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


mock_aws().start()
create_table(boto3.client("dynamodb"), TABLE_NAME)
app = create_app(store=seeded_store, auth=fake_auth)
