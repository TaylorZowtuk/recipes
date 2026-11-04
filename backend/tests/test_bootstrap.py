from typing import TYPE_CHECKING, Any

import boto3
import pytest
from fastapi.testclient import TestClient

from recipes.api import create_app
from recipes.models import SCHEMA_VERSION
from recipes.store import (
    ATTEMPTS,
    FAVORITE_SITES_KEY,
    SchemaMismatch,
    SchemaMissing,
    Store,
    VersionConflict,
)

if TYPE_CHECKING:
    from collections.abc import Callable

    from botocore.exceptions import ClientError
    from fastapi import FastAPI

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


def test_bootstrap_seeds_an_empty_list_of_favorite_sites(table: str) -> None:
    store = Store(table)

    store.bootstrap()

    sites = store.favorite_sites()
    assert (sites.schema_version, sites.version, sites.sites) == (SCHEMA_VERSION, 1, [])
    assert store.collection_version() == 1


def test_bootstrapping_again_keeps_the_favorite_sites(table: str) -> None:
    first, second = Store(table), Store(table)
    first.bootstrap()
    saved = first.save_favorite_sites(first.favorite_sites())
    version = first.collection_version()

    second.bootstrap()

    assert second.favorite_sites() == saved
    assert second.collection_version() == version


def lacking_favorite_sites(table: str) -> Store:
    """A stack bootstrapped before Favorite Sites, with a write since."""
    store = Store(table)
    store.bootstrap()
    store.client.delete_item(TableName=table, Key=FAVORITE_SITES_KEY)
    store.save_kitchen_settings(store.kitchen_settings())
    return store


def test_an_existing_stack_gains_the_favorite_sites_and_moves_the_counter(table: str) -> None:
    store = lacking_favorite_sites(table)
    version = store.collection_version()
    settings = store.kitchen_settings()

    store.bootstrap()

    assert store.favorite_sites().sites == []
    assert store.collection_version() == version + 1
    assert store.kitchen_settings() == settings


def test_a_second_start_on_that_stack_changes_nothing(table: str) -> None:
    store = lacking_favorite_sites(table)
    store.bootstrap()
    version = store.collection_version()
    sites = store.favorite_sites()

    Store(table).bootstrap()

    assert store.favorite_sites() == sites
    assert store.collection_version() == version


def test_the_bundle_of_an_existing_stack_is_served_once_it_has_started(
    table: str, app: FastAPI
) -> None:
    version = lacking_favorite_sites(table).collection_version()

    with TestClient(app) as client:
        response = client.get(f"/api/v/collection/{version + 1}")

    assert response.status_code == 200
    assert response.json()["favorite_sites"] == {"version": 1, "sites": []}


def test_a_start_that_loses_the_race_to_add_the_sites_bumps_nothing(
    table: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    winner = lacking_favorite_sites(table)
    version = winner.collection_version()
    loser = Store(table)
    get_item = loser.client.get_item

    def racing_get_item(**kwargs: Any) -> Any:
        found = get_item(**kwargs)
        if kwargs["Key"] == FAVORITE_SITES_KEY and "Item" not in found:
            winner.bootstrap()  # after the loser saw it missing, before it writes
        return found

    monkeypatch.setattr(loser.client, "get_item", racing_get_item)

    loser.bootstrap()

    assert loser.favorite_sites().version == 1
    assert loser.collection_version() == version + 1


def test_a_start_cancelled_while_the_winner_adds_the_sites_still_starts(
    table: str, monkeypatch: pytest.MonkeyPatch, cancellation: Callable[..., ClientError]
) -> None:
    winner = lacking_favorite_sites(table)
    version = winner.collection_version()
    loser = Store(table, sleep=lambda _: None)
    mixed = cancellation("ConditionalCheckFailed", "TransactionConflict")

    def mixed_cancellation(**_kwargs: Any) -> Any:
        winner.bootstrap()
        raise mixed

    monkeypatch.setattr(loser.client, "transact_write_items", mixed_cancellation)

    loser.bootstrap()

    assert loser.collection_version() == version + 1


def test_a_start_that_cant_add_the_sites_fails_rather_than_serve_without_them(
    table: str, monkeypatch: pytest.MonkeyPatch, cancellation: Callable[..., ClientError]
) -> None:
    store = lacking_favorite_sites(table)
    sleeps: list[float] = []
    store.sleep = sleeps.append
    conflict = cancellation("TransactionConflict", "None")

    def conflicting(**_kwargs: Any) -> Any:
        raise conflict

    monkeypatch.setattr(store.client, "transact_write_items", conflicting)

    with pytest.raises(VersionConflict):
        store.bootstrap()

    assert len(sleeps) == ATTEMPTS - 1


def test_a_start_cancelled_for_another_reason_fails(
    table: str, monkeypatch: pytest.MonkeyPatch, cancellation: Callable[..., ClientError]
) -> None:
    store = lacking_favorite_sites(table)
    invalid = cancellation("ValidationError", "None")

    def refused(**_kwargs: Any) -> Any:
        raise invalid

    monkeypatch.setattr(store.client, "transact_write_items", refused)

    with pytest.raises(Exception, match="ValidationError"):
        store.bootstrap()


def test_a_bootstrapped_table_is_only_read(store: Store, monkeypatch: pytest.MonkeyPatch) -> None:
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

    assert len(reads) == 2  # META#schema and the Favorite Sites


def test_a_start_that_loses_the_bootstrap_race_still_starts(
    table: str, monkeypatch: pytest.MonkeyPatch, cancellation: Callable[..., ClientError]
) -> None:
    winner, loser = Store(table), Store(table)
    sleeps: list[float] = []
    loser.sleep = sleeps.append
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
    assert sleeps


def test_a_start_cancelled_while_the_winner_commits_waits_for_it(
    table: str, monkeypatch: pytest.MonkeyPatch, cancellation: Callable[..., ClientError]
) -> None:
    winner, loser = Store(table), Store(table)
    sleeps: list[float] = []
    loser.sleep = sleeps.append
    get_item = loser.client.get_item
    unseen = [1, 2]

    def lagging_get_item(**kwargs: Any) -> Any:
        if unseen:
            unseen.pop()
            return {}
        return get_item(**kwargs)

    mixed = cancellation("ConditionalCheckFailed", "TransactionConflict", "None")

    def mixed_cancellation(**_kwargs: Any) -> Any:
        winner.bootstrap()
        raise mixed

    monkeypatch.setattr(loser.client, "get_item", lagging_get_item)
    monkeypatch.setattr(loser.client, "transact_write_items", mixed_cancellation)

    loser.bootstrap()

    assert loser.schema_version() == SCHEMA_VERSION
    assert len(sleeps) == 1  # it waited for the schema once, after its first read missed


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
