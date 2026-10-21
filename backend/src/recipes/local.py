"""The API on a fake stack: moto's DynamoDB, bootstrapped and loaded with the synthetic seed.

Importing this module starts an empty fake, so under `uvicorn --reload` every restart begins
from the same seeded Collection.
"""

import os

import boto3
from moto import mock_aws

from recipes import seed
from recipes.api import create_app
from recipes.store import Store, create_table

TABLE_NAME = "plateful-local"

os.environ.setdefault("AWS_DEFAULT_REGION", "us-west-2")


def seeded_store() -> Store:
    """The fake table, bootstrapped and seeded. Adding a recipe bumps `META#collection`, so the
    bootstrap comes first; the API's own start then finds the table at its schema version.
    """
    store = Store(TABLE_NAME)
    store.bootstrap()
    seed.load(store)
    return store


mock_aws().start()
create_table(boto3.client("dynamodb"), TABLE_NAME)
app = create_app(store=seeded_store)
