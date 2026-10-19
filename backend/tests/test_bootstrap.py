from typing import TYPE_CHECKING, Any

import boto3
import pytest
from fastapi.testclient import TestClient

from recipes.api import create_app
from recipes.models import SCHEMA_VERSION
from recipes.store import SchemaMismatch, SchemaMissing, Store

if TYPE_CHECKING:
    from collections.abc import Callable

    from botocore.exceptions import ClientError

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


def test_a_bootstrapped_table_is_read_once_and_never_written(
    store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    get_item = store.client.get_item
    reads: list[object] = []

    def counted_get_item(**kwargs: Any) -> Any:
        reads.append(kwargs)
        return get_item(**kwargs)

    def no_write(**_kwargs: Any) -> Any:
        pytest.fail("a bootstrapped table was written")

    monkeypatch.setattr(store.client, "get_item", counted_get_item)
    monkeypatch.setattr(store.client, "transact_write_items", no_write)

    store.bootstrap()

    assert len(reads) == 1


def test_a_start_that_loses_the_bootstrap_race_still_starts(
    table: str, monkeypatch: pytest.MonkeyPatch, cancellation: Callable[..., ClientError]
) -> None:
    winner, loser = Store(table), Store(table, sleep=lambda _: None)
    get_item = loser.client.get_item
    unseen = [1, 2]

    def lagging_get_item(**kwargs: Any) -> Any:
        # The loser doesn't see the winner's schema at first.
        if unseen:
            unseen.pop()
            return {}
        return get_item(**kwargs)

    conflict = cancellation("TransactionConflict", "TransactionConflict", "TransactionConflict")

    def conflicting(**_kwargs: Any) -> Any:
        if winner.schema_version() is None:
            winner.bootstrap()
        raise conflict

    monkeypatch.setattr(loser.client, "get_item", lagging_get_item)
    monkeypatch.setattr(loser.client, "transact_write_items", conflicting)

    loser.bootstrap()

    assert loser.schema_version() == SCHEMA_VERSION
    assert loser.collection_version() == 1


def test_a_bootstrap_cancelled_for_another_reason_fails(
    table: str, monkeypatch: pytest.MonkeyPatch, cancellation: Callable[..., ClientError]
) -> None:
    store = Store(table, sleep=lambda _: None)

    invalid_item = cancellation("ValidationError", "None", "None")

    def invalid(**_kwargs: Any) -> Any:
        raise invalid_item

    monkeypatch.setattr(store.client, "transact_write_items", invalid)

    with pytest.raises(Exception, match="ValidationError"):
        store.bootstrap()


def test_a_schema_that_never_appears_is_its_own_error(
    table: str, monkeypatch: pytest.MonkeyPatch, cancellation: Callable[..., ClientError]
) -> None:
    store = Store(table, sleep=lambda _: None)

    bootstrapped = cancellation("ConditionalCheckFailed", "ConditionalCheckFailed", "None")

    def already_there(**_kwargs: Any) -> Any:
        raise bootstrapped

    monkeypatch.setattr(store.client, "transact_write_items", already_there)

    with pytest.raises(SchemaMissing):
        store.bootstrap()


@pytest.mark.parametrize("stored", [SCHEMA_VERSION + 1, SCHEMA_VERSION - 1])
def test_the_api_refuses_to_start_on_another_schema_version(table: str, stored: int) -> None:
    boto3.client("dynamodb").put_item(
        TableName=table,
        Item={
            "PK": {"S": "META#schema"},
            "SK": {"S": "META"},
            "schema_version": {"N": str(stored)},
        },
    )

    with pytest.raises(SchemaMismatch), TestClient(create_app(store=lambda: Store(table))):
        pass
