"""The API on a fake stack: moto's DynamoDB, bootstrapped and loaded with the synthetic seed.

Importing this module starts the fake, so it suits `uvicorn --reload`: every restart begins from
the same seeded Collection. `make dev` and the end-to-end tests serve it.
"""

import os

import boto3
from moto import mock_aws

from recipes import seed
from recipes.api import create_app
from recipes.store import create_table

os.environ.setdefault("AWS_DEFAULT_REGION", "ca-west-1")
os.environ.setdefault("TABLE_NAME", "plateful-local")

mock_aws().start()
create_table(boto3.client("dynamodb"), os.environ["TABLE_NAME"])
app = create_app(seed=seed.load)
