import boto3
import pytest
from fastapi.testclient import TestClient

from recipes.api import create_app
from recipes.models import SCHEMA_VERSION
from recipes.store import SchemaMismatch, Store

STORE_CATEGORIES = ["Household", "Produce", "Meat", "Aisles", "Spices", "Dairy", "Frozen", "Bakery"]


def test_bootstrap_seeds_the_store_categories_in_order(table: str) -> None:
    store = Store(table)

    store.bootstrap()

    settings = store.kitchen_settings()
    assert [category.name for category in settings.store_categories] == STORE_CATEGORIES
    assert len({category.id for category in settings.store_categories}) == len(STORE_CATEGORIES)
    assert store.schema_version() == SCHEMA_VERSION


def test_bootstrapping_again_changes_nothing(table: str) -> None:
    first, second = Store(table), Store(table)
    first.bootstrap()
    settings = first.kitchen_settings()
    renamed = settings.store_categories[0].model_copy(update={"name": "Home"})
    first.save_kitchen_settings(
        settings.model_copy(update={"store_categories": [renamed, *settings.store_categories[1:]]})
    )
    version = first.collection_version()

    second.bootstrap()

    assert second.kitchen_settings().store_categories[0].name == "Home"
    assert second.collection_version() == version


def test_the_api_refuses_to_start_on_another_schema_version(table: str) -> None:
    boto3.client("dynamodb").put_item(
        TableName=table,
        Item={
            "PK": {"S": "META#schema"},
            "SK": {"S": "META"},
            "schema_version": {"N": str(SCHEMA_VERSION + 1)},
        },
    )

    with pytest.raises(SchemaMismatch), TestClient(create_app()):
        pass
