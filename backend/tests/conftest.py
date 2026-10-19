from typing import TYPE_CHECKING

import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from recipes.api import create_app
from recipes.store import Store, create_table

if TYPE_CHECKING:
    from collections.abc import Iterator

    from fastapi import FastAPI

TABLE_NAME = "plateful-test"


@pytest.fixture
def table(monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    """An empty table on fake AWS, named by TABLE_NAME as on a real stack."""
    monkeypatch.setenv("AWS_DEFAULT_REGION", "ca-west-1")
    monkeypatch.setenv("TABLE_NAME", TABLE_NAME)
    with mock_aws():
        create_table(boto3.client("dynamodb"), TABLE_NAME)
        yield TABLE_NAME


@pytest.fixture
def store(table: str) -> Store:
    """A bootstrapped store, as the API leaves it once it has started."""
    store = Store(table)
    store.bootstrap()
    return store


@pytest.fixture
def app(table: str) -> FastAPI:
    return create_app()


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    """The API over HTTP, started (bootstrap and schema check included) on the fake table."""
    with TestClient(app, follow_redirects=False) as client:
        yield client
