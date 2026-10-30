"""The single DynamoDB table: recipes, their cards, Source guards, Queued Ingests, Canonical
Ingredients, the Wording Cache, Kitchen settings and meta items.

The API is the table's only writer. Every write to shared collection data bumps `META#collection`
in the same transaction, and versioned items are written only if their version hasn't changed.
"""

import json
import os
import random
import time
from decimal import Decimal
from typing import TYPE_CHECKING, Any, cast

import boto3
from boto3.dynamodb.types import TypeDeserializer, TypeSerializer
from botocore.exceptions import ClientError

from recipes.models import (
    SCHEMA_VERSION,
    CanonicalIngredient,
    Card,
    CollectionMeta,
    KitchenSettings,
    QueuedIngest,
    Recipe,
    SchemaMeta,
    SourceGuard,
    StoreCategory,
    Wording,
    card_for,
)

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable

    from pydantic import BaseModel
    from types_boto3_dynamodb import DynamoDBClient
    from types_boto3_dynamodb.type_defs import QueryInputTypeDef, TransactWriteItemTypeDef

# An item in DynamoDB's attribute-value form, e.g. {"PK": {"S": "CARD"}}.
type Item = dict[str, Any]

COLLECTION_KEY: Item = {"PK": {"S": "META#collection"}, "SK": {"S": "META"}}
SCHEMA_KEY: Item = {"PK": {"S": "META#schema"}, "SK": {"S": "META"}}
KITCHEN_KEY: Item = {"PK": {"S": "SETTINGS#kitchen"}, "SK": {"S": "SETTINGS"}}

# The Store Categories a new stack starts with, in Grocery List order.
STORE_CATEGORIES = ["Household", "Produce", "Meat", "Aisles", "Spices", "Dairy", "Frozen", "Bakery"]

# A transaction holds at most 100 items. Store.enrich_recipe writes these three, and one more for
# each Canonical Ingredient it creates and wording it learns.
MAX_TRANSACTION_ITEMS = 100
ENRICH_FIXED_ITEMS = ("the recipe", "its card", "META#collection")
MAX_LEARNED = MAX_TRANSACTION_ITEMS - len(ENRICH_FIXED_ITEMS)

# How many times a transaction or a read is tried before giving up, and the first backoff.
ATTEMPTS = 4
BACKOFF_SECONDS = 0.05


class VersionConflict(Exception):
    """The item changed since it was read: reload and show the newer state."""


class DuplicateSource(Exception):
    """A recipe from this Source is in the Collection, or a Queued Ingest has reserved it."""


class CanonicalExists(Exception):
    """A Canonical Ingredient with this id is already in the table."""


class WordingConfirmed(Exception):
    """An editor confirmed this wording's Canonical Ingredient, so enrichment can't replace it."""


class SchemaMismatch(RuntimeError):
    """The table holds another schema version than this code handles."""


class SchemaMissing(RuntimeError):
    """`META#schema` is still missing after bootstrapping, so the table's version is unknown."""


def recipe_key(recipe_id: str) -> Item:
    return {"PK": {"S": f"RECIPE#{recipe_id}"}, "SK": {"S": "RECIPE"}}


def card_key(recipe_id: str) -> Item:
    return {"PK": {"S": "CARD"}, "SK": {"S": recipe_id}}


def source_key(dedupe_key: str) -> Item:
    return {"PK": {"S": f"SOURCE#{dedupe_key}"}, "SK": {"S": "SOURCE"}}


def queued_ingest_key(ingest_id: str) -> Item:
    # One partition, like the cards, so listing them is a query. ULIDs sort in queue order.
    return {"PK": {"S": "INGEST"}, "SK": {"S": ingest_id}}


def canonical_key(canonical_id: str) -> Item:
    return {"PK": {"S": "CANON"}, "SK": {"S": canonical_id}}


def wording_key(wording: str) -> Item:
    return {"PK": {"S": "WORDING"}, "SK": {"S": wording}}


_serializer = TypeSerializer()
_deserializer = TypeDeserializer()


def _to_item(model: BaseModel, key: Item) -> Item:
    stored = getattr(model, "schema_version", None)
    if stored != SCHEMA_VERSION:
        msg = f"{key['PK']['S']} is at schema version {stored}, not {SCHEMA_VERSION}"
        raise ValueError(msg)
    # DynamoDB takes numbers as Decimal, never float.
    document = json.loads(model.model_dump_json(), parse_float=Decimal)
    return {**key, **{name: _serializer.serialize(value) for name, value in document.items()}}


def _plain(value: object) -> object:
    # DynamoDB returns every number as Decimal: whole ones become ints, the rest floats.
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in cast("dict[str, object]", value).items()}
    if isinstance(value, list):
        return [_plain(v) for v in cast("list[object]", value)]
    return value


def _from_item[M: BaseModel](model: type[M], item: Item) -> M:
    document = {
        name: _deserializer.deserialize(value)
        for name, value in item.items()
        if name not in {"PK", "SK"}
    }
    return model.model_validate(_plain(document))


def create_table(client: DynamoDBClient, name: str) -> None:
    """Create the table on fake AWS. Terraform creates the real stacks' tables."""
    client.create_table(
        TableName=name,
        KeySchema=[
            {"AttributeName": "PK", "KeyType": "HASH"},
            {"AttributeName": "SK", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "PK", "AttributeType": "S"},
            {"AttributeName": "SK", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )


def _backoff(attempt: int) -> float:
    """A random delay up to twice the last, so racing writers spread out."""
    return random.SystemRandom().uniform(0, BACKOFF_SECONDS * 2**attempt)


class Store:
    def __init__(
        self,
        table_name: str,
        client: DynamoDBClient | None = None,
        *,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.table = table_name
        self.client: DynamoDBClient = client or boto3.client("dynamodb")
        self.sleep = sleep

    @classmethod
    def from_env(cls) -> Store:
        return cls(os.environ["TABLE_NAME"])

    # Bootstrap and schema

    def bootstrap(self) -> None:
        """Bootstrap a new stack, or check an existing one is at this code's schema version.

        Raises SchemaMismatch if it isn't, so the API refuses to start.
        """
        stored = self.schema_version()
        if stored is None:
            self._create_stack()
            stored = self._await_schema_version()
        if stored != SCHEMA_VERSION:
            msg = f"The table is at schema version {stored}, but this API handles {SCHEMA_VERSION}"
            raise SchemaMismatch(msg)

    def schema_version(self) -> int | None:
        item = self._get(SCHEMA_KEY, consistent=True)
        return None if item is None else _from_item(SchemaMeta, item).schema_version

    def collection_version(self) -> int:
        return _from_item(CollectionMeta, self._get_bootstrapped(COLLECTION_KEY)).collection_version

    def _create_stack(self) -> None:
        settings = KitchenSettings(
            schema_version=SCHEMA_VERSION,
            version=1,
            store_categories=[StoreCategory(id=n.lower(), name=n) for n in STORE_CATEGORIES],
        )
        # Creating the Kitchen settings is the collection's first write.
        collection = CollectionMeta(schema_version=SCHEMA_VERSION, collection_version=1)
        try:
            self._transact(
                [
                    self._create(SchemaMeta(schema_version=SCHEMA_VERSION), SCHEMA_KEY),
                    self._create(collection, COLLECTION_KEY),
                    self._create(settings, KITCHEN_KEY),
                ]
            )
        except VersionConflict:
            pass  # another start kept winning the race, so it's bootstrapping the stack
        except _Cancelled as cancelled:
            # Another start bootstrapped the stack first, or is doing so now.
            if not cancelled.reasons <= {"ConditionalCheckFailed", "TransactionConflict"}:
                raise

    def _await_schema_version(self) -> int:
        """`META#schema` once some start's bootstrap has written it, which may take a moment."""
        for attempt in range(ATTEMPTS):
            stored = self.schema_version()
            if stored is not None:
                return stored
            if attempt < ATTEMPTS - 1:
                self.sleep(_backoff(attempt))
        msg = "META#schema is still missing after bootstrapping"
        raise SchemaMissing(msg)

    # Recipes and their cards

    def add_recipe(self, recipe: Recipe) -> Recipe:
        """Add a new recipe at version 1, with its card and its Source guard."""
        added = recipe.model_copy(update={"version": 1})
        guard = self._guard_source(
            SourceGuard(schema_version=added.schema_version, recipe_id=added.id), added.dedupe_key
        )
        try:
            self._transact(
                [
                    guard,
                    self._create(added, recipe_key(added.id)),
                    self._put_card(added),
                    self._bump_collection(),
                ]
            )
        except _Cancelled as cancelled:
            if cancelled.failed(guard):
                raise DuplicateSource(added.dedupe_key) from None
            raise
        return added

    def update_recipe(self, recipe: Recipe) -> Recipe:
        """Write the recipe and its card if the stored recipe is still at `recipe.version`.

        A changed `dedupe_key` would strand its Source guard, so it's refused as a VersionConflict.
        """
        return self._save_versioned(
            recipe,
            recipe_key(recipe.id),
            shared=True,
            also=lambda saved: [self._put_card(saved)],
            unchanged=("dedupe_key",),
        )

    def enrich_recipe(
        self,
        recipe: Recipe,
        canonical_ingredients: Iterable[CanonicalIngredient],
        wordings: Iterable[Wording],
    ) -> Recipe:
        """`update_recipe`, creating the new Canonical Ingredients at version 1 and learning the
        wordings in the same transaction: ENRICH_FIXED_ITEMS and these, at most MAX_LEARNED.

        Raises CanonicalExists or WordingConfirmed, and VersionConflict, writing nothing.
        """
        created = [
            self._create(canonical.model_copy(update={"version": 1}), canonical_key(canonical.id))
            for canonical in canonical_ingredients
        ]
        learned = [self._learn_wording(wording) for wording in wordings]
        try:
            return self._save_versioned(
                recipe,
                recipe_key(recipe.id),
                shared=True,
                also=lambda saved: [self._put_card(saved), *created, *learned],
                unchanged=("dedupe_key",),
            )
        except _Cancelled as cancelled:
            if any(cancelled.failed(item) for item in created):
                raise CanonicalExists from None
            if any(cancelled.failed(item) for item in learned):
                raise WordingConfirmed from None
            raise

    def delete_recipe(self, recipe: Recipe) -> None:
        """Delete the recipe, its card and its Source guard if the stored recipe is still at
        `recipe.version`, so its Source can be added again. Raises VersionConflict otherwise.
        """
        deleted: TransactWriteItemTypeDef = {
            "Delete": {
                "TableName": self.table,
                "Key": recipe_key(recipe.id),
                "ConditionExpression": "#version = :expected",
                "ExpressionAttributeNames": {"#version": "version"},
                "ExpressionAttributeValues": {":expected": {"N": str(recipe.version)}},
            }
        }
        guard: TransactWriteItemTypeDef = {
            "Delete": {
                "TableName": self.table,
                "Key": source_key(recipe.dedupe_key),
                "ConditionExpression": "recipe_id = :id",
                "ExpressionAttributeValues": {":id": {"S": recipe.id}},
            }
        }
        try:
            self._transact(
                [
                    deleted,
                    {"Delete": {"TableName": self.table, "Key": card_key(recipe.id)}},
                    guard,
                    self._bump_collection(),
                ]
            )
        except _Cancelled as cancelled:
            # A Source guard that is gone or names another recipe leaves the delete unsafe too.
            if cancelled.failed(deleted) or cancelled.failed(guard):
                raise VersionConflict(recipe.id) from None
            raise

    def get_recipe(self, recipe_id: str) -> Recipe | None:
        # Consistent, like the card that names the version a phone asks for.
        item = self._get(recipe_key(recipe_id), consistent=True)
        return None if item is None else _from_item(Recipe, item)

    def cards(self, page_size: int | None = None) -> list[Card]:
        """Every card, in id order, read consistently so none is older than the counter.

        `page_size` lets tests force several pages.
        """
        return self._partition(Card, "CARD", page_size)

    # Canonical Ingredients and the Wording Cache

    def canonical_ingredients(self, page_size: int | None = None) -> list[CanonicalIngredient]:
        """Every Canonical Ingredient, in id order. `page_size` lets tests force several pages."""
        return self._partition(CanonicalIngredient, "CANON", page_size)

    def wordings(self, page_size: int | None = None) -> list[Wording]:
        """The Wording Cache, in wording order. `page_size` lets tests force several pages."""
        return self._partition(Wording, "WORDING", page_size)

    # Source guards and Queued Ingests

    def source_guard(self, dedupe_key: str) -> SourceGuard | None:
        """What has claimed the Source with this dedupe key, if anything has."""
        item = self._get(source_key(dedupe_key), consistent=True)
        return None if item is None else _from_item(SourceGuard, item)

    def queue_ingest(self, queued: QueuedIngest) -> None:
        """Add a Queued Ingest with the Source guard that reserves its Source. It isn't shared
        collection data, so `META#collection` stays as it is.
        """
        guard = self._guard_source(
            SourceGuard(schema_version=queued.schema_version, queued_ingest_id=queued.id),
            queued.dedupe_key,
        )
        try:
            self._transact([guard, self._create(queued, queued_ingest_key(queued.id))])
        except _Cancelled as cancelled:
            if cancelled.failed(guard):
                raise DuplicateSource(queued.dedupe_key) from None
            raise

    def queued_ingests(self, page_size: int | None = None) -> list[QueuedIngest]:
        """Every Queued Ingest, oldest first. `page_size` lets tests force several pages."""
        return self._partition(QueuedIngest, "INGEST", page_size)

    # Kitchen settings

    def kitchen_settings(self) -> KitchenSettings:
        return _from_item(KitchenSettings, self._get_bootstrapped(KITCHEN_KEY))

    def save_kitchen_settings(self, settings: KitchenSettings) -> KitchenSettings:
        """Write the settings if the stored ones are still at `settings.version`."""
        return self._save_versioned(settings, KITCHEN_KEY, shared=True)

    # Building blocks

    def _save_versioned[M: Recipe | KitchenSettings](
        self,
        model: M,
        key: Item,
        *,
        shared: bool,
        also: Callable[[M], Iterable[TransactWriteItemTypeDef]] = lambda _: (),
        unchanged: Iterable[str] = (),
    ) -> M:
        """Write `model` at its next version if the stored item is still at `model.version`, and
        hasn't changed its `unchanged` fields. `also` builds the writes that go with it, and
        `shared` bumps `META#collection`, as every write to shared collection data must.

        Raises VersionConflict otherwise.
        """
        saved = model.model_copy(update={"version": model.version + 1})
        versioned = self._replace(saved, key, model.version, unchanged)
        items = [versioned, *also(saved)]
        if shared:
            items.append(self._bump_collection())
        try:
            self._transact(items)
        except _Cancelled as cancelled:
            if cancelled.failed(versioned):
                raise VersionConflict(key["PK"]["S"]) from None
            raise
        return saved

    def _partition[M: BaseModel](self, model: type[M], pk: str, page_size: int | None) -> list[M]:
        """Every item in partition `pk`, in sort key order, read consistently."""
        query: QueryInputTypeDef = {
            "TableName": self.table,
            "KeyConditionExpression": "PK = :pk",
            "ExpressionAttributeValues": {":pk": {"S": pk}},
            "ConsistentRead": True,
        }
        if page_size:
            query["Limit"] = page_size
        items: list[M] = []
        while True:
            page = self.client.query(**query)
            items += [_from_item(model, item) for item in page.get("Items", [])]
            if "LastEvaluatedKey" not in page:
                return items
            query["ExclusiveStartKey"] = page["LastEvaluatedKey"]

    def _get(self, key: Item, *, consistent: bool = False) -> Item | None:
        response = self.client.get_item(TableName=self.table, Key=key, ConsistentRead=consistent)
        return response.get("Item")

    def _get_bootstrapped(self, key: Item) -> Item:
        item = self._get(key, consistent=True)
        if item is None:
            msg = f"{key['PK']['S']} is missing: the table hasn't been bootstrapped"
            raise LookupError(msg)
        return item

    def _create(self, model: BaseModel, key: Item) -> TransactWriteItemTypeDef:
        return {
            "Put": {
                "TableName": self.table,
                "Item": _to_item(model, key),
                "ConditionExpression": "attribute_not_exists(PK)",
            }
        }

    def _replace(
        self, model: BaseModel, key: Item, expected: int, unchanged: Iterable[str] = ()
    ) -> TransactWriteItemTypeDef:
        item = _to_item(model, key)
        # Placeholders, as a field name may be a DynamoDB reserved word such as `status`.
        fields = list(unchanged)
        names = {"#version": "version", **{f"#u{n}": name for n, name in enumerate(fields)}}
        conditions = ["#version = :expected", *(f"#u{n} = :u{n}" for n in range(len(fields)))]
        return {
            "Put": {
                "TableName": self.table,
                "Item": item,
                "ConditionExpression": " AND ".join(conditions),
                "ExpressionAttributeNames": names,
                "ExpressionAttributeValues": {
                    ":expected": {"N": str(expected)},
                    **{f":u{n}": item[name] for n, name in enumerate(fields)},
                },
            }
        }

    def _guard_source(self, guard: SourceGuard, dedupe_key: str) -> TransactWriteItemTypeDef:
        """Claim the Source, so a second recipe or Queued Ingest from it is refused."""
        return self._create(guard, source_key(dedupe_key))

    def _learn_wording(self, wording: Wording) -> TransactWriteItemTypeDef:
        """Point the wording at its Canonical Ingredient, unless an editor confirmed it."""
        return {
            "Put": {
                "TableName": self.table,
                "Item": _to_item(wording, wording_key(wording.wording)),
                "ConditionExpression": "attribute_not_exists(PK) OR confirmed = :false",
                "ExpressionAttributeValues": {":false": {"BOOL": False}},
            }
        }

    def _put_card(self, recipe: Recipe) -> TransactWriteItemTypeDef:
        item = _to_item(card_for(recipe), card_key(recipe.id))
        return {"Put": {"TableName": self.table, "Item": item}}

    def _bump_collection(self) -> TransactWriteItemTypeDef:
        return {
            "Update": {
                "TableName": self.table,
                "Key": COLLECTION_KEY,
                "UpdateExpression": "ADD collection_version :one",
                "ConditionExpression": "attribute_exists(PK)",
                "ExpressionAttributeValues": {":one": {"N": "1"}},
            }
        }

    def _transact(self, items: list[TransactWriteItemTypeDef]) -> None:
        """Write `items` in one transaction, retrying while it only conflicts with another one.

        The conditions still guard a retry against staleness. Raises VersionConflict once the
        retries are spent, and _Cancelled for any other cancellation.
        """
        for attempt in range(ATTEMPTS):
            try:
                self.client.transact_write_items(TransactItems=items)
            except ClientError as error:
                if error.response.get("Error", {}).get("Code") != "TransactionCanceledException":
                    raise
                reasons = cast(
                    "list[dict[str, Any]]", error.response.get("CancellationReasons", [])
                )
                cancelled = _Cancelled(items, [reason.get("Code") for reason in reasons])
                if cancelled.reasons != {"TransactionConflict"}:
                    raise cancelled from error
                if attempt == ATTEMPTS - 1:
                    msg = "The transaction kept conflicting with another write"
                    raise VersionConflict(msg) from error
                self.sleep(_backoff(attempt))
            else:
                return


class _Cancelled(Exception):
    """A transaction DynamoDB cancelled, with each item's reason in order."""

    def __init__(self, items: list[TransactWriteItemTypeDef], codes: list[str | None]) -> None:
        super().__init__(codes)
        self.items = items
        self.codes = codes

    @property
    def reasons(self) -> set[str]:
        """The reasons of the items that failed. DynamoDB gives the others the code "None"."""
        return {code for code in self.codes if code is not None and code != "None"}

    def failed(self, item: TransactWriteItemTypeDef) -> bool:
        """Whether `item`'s condition failed."""
        index = next(n for n, each in enumerate(self.items) if each is item)
        return len(self.codes) > index and self.codes[index] == "ConditionalCheckFailed"
