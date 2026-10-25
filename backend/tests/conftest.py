from typing import TYPE_CHECKING

import boto3
import pytest
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient
from moto import mock_aws

from recipes.api import create_app
from recipes.auth import Auth, AuthSettings, Claims, InvalidIdToken
from recipes.images import ImageStore
from recipes.store import Store, create_table

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    from fastapi import FastAPI

TABLE_NAME = "plateful-test"
IMAGES_BUCKET = "plateful-test-images"


@pytest.fixture
def table(monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    """An empty table on fake AWS."""
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-west-2")
    with mock_aws():
        create_table(boto3.client("dynamodb"), TABLE_NAME)
        yield TABLE_NAME


@pytest.fixture
def images(table: str) -> ImageStore:
    """An empty images bucket on the same fake AWS."""
    boto3.client("s3").create_bucket(
        Bucket=IMAGES_BUCKET, CreateBucketConfiguration={"LocationConstraint": "us-west-2"}
    )
    return ImageStore(IMAGES_BUCKET)


@pytest.fixture
def store(table: str) -> Store:
    """A bootstrapped store, as the API leaves it once it has started."""
    store = Store(table)
    store.bootstrap()
    return store


def no_sign_in(token: str, audience: str) -> Claims:
    raise InvalidIdToken(token)


# Sign-in as a stack has it before its settings are written: no one is an editor.
UNCONFIGURED = Auth(settings=lambda: AuthSettings.parse({}), verifier=no_sign_in)


@pytest.fixture
def app(table: str, images: ImageStore) -> FastAPI:
    return create_app(store=lambda: Store(table), auth=lambda: UNCONFIGURED, images=lambda: images)


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    """The API over HTTP, started (bootstrap and schema check included) on the fake table."""
    with TestClient(app, follow_redirects=False) as client:
        yield client


@pytest.fixture
def cancellation() -> Callable[..., ClientError]:
    """Builds the error DynamoDB raises when it cancels a transaction, one reason per item.

    moto never cancels for a TransactionConflict, so tests raise this from a stubbed client.
    """

    def build(*codes: str) -> ClientError:
        return ClientError(
            {
                "Error": {"Code": "TransactionCanceledException", "Message": "cancelled"},
                "CancellationReasons": [{"Code": code} for code in codes],
            },
            "TransactWriteItems",
        )

    return build
