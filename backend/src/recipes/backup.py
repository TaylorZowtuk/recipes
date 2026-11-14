"""The Backup Snapshot: a paced Scan of the stack's table, written as one gzipped JSON Lines file
to the backup bucket, then a copy of every image the backup bucket doesn't hold yet.

A scheduled Lambda runs it nightly and before every release, with a plain Python handler. The
first nightly of each UTC month is also kept as that month's snapshot.

Line 1 of a snapshot is a header; every other line is one item exactly as DynamoDB's low-level
client returns it, so sets and numbers load unchanged into another stack's table.
"""

import gzip
import json
import logging
import os
import random
import time
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, TypedDict

import boto3
from botocore.exceptions import ClientError

from recipes.store import SCHEMA_KEY

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    from types_boto3_dynamodb import DynamoDBClient
    from types_boto3_dynamodb.type_defs import ScanInputTypeDef, ScanOutputTypeDef
    from types_boto3_s3 import S3Client

    from recipes.store import Item

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# The kinds the Lambda is invoked with. Monthly snapshots are copies of a nightly one.
INVOKED_KINDS = ("nightly", "pre-release")
KINDS = (*INVOKED_KINDS, "monthly")
FORMAT = "plateful-backup"
VERSION = 1
PAGE_ITEMS = 100
ATTEMPTS = 6
BACKOFF_SECONDS = 0.5
THROTTLED = {"ProvisionedThroughputExceededException", "ThrottlingException"}
IMAGES = "images/"


class Summary(TypedDict):
    snapshot: str
    monthly: str | None
    items: int
    images_copied: int


def snapshot_key(kind: str, at: datetime) -> str:
    return f"snapshots/{kind}/{at.astimezone(UTC):%Y-%m-%dT%H%M%SZ}.jsonl.gz"


def scan_table(
    client: DynamoDBClient,
    table: str,
    read_units: float,
    *,
    sleep: Callable[[float], None] = time.sleep,
    page_items: int = PAGE_ITEMS,
) -> list[Item]:
    """Every item, eventually consistent, sleeping after each page so the average read rate
    stays at or under `read_units` per second.
    """
    items: list[Item] = []
    request: ScanInputTypeDef = {
        "TableName": table,
        "Limit": page_items,
        "ReturnConsumedCapacity": "TOTAL",
    }
    while True:
        page = _scan_page(client, request, sleep)
        items += page["Items"]
        sleep(page.get("ConsumedCapacity", {}).get("CapacityUnits", 0) / read_units)
        if "LastEvaluatedKey" not in page:
            return items
        request["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def _scan_page(
    client: DynamoDBClient, request: ScanInputTypeDef, sleep: Callable[[float], None]
) -> ScanOutputTypeDef:
    for attempt in range(ATTEMPTS):
        try:
            return client.scan(**request)
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") not in THROTTLED:
                raise
            if attempt == ATTEMPTS - 1:
                raise
            sleep(random.SystemRandom().uniform(0, BACKOFF_SECONDS * 2**attempt))
    raise AssertionError  # unreachable: the last attempt returns or raises


def _schema_version(items: list[Item]) -> int | None:
    for item in items:
        if item["PK"] == SCHEMA_KEY["PK"] and item["SK"] == SCHEMA_KEY["SK"]:
            return int(item["schema_version"]["N"])
    return None


def take_snapshot(
    dynamodb: DynamoDBClient,
    s3: S3Client,
    *,
    table: str,
    bucket: str,
    images_bucket: str | None,
    kind: str,
    read_units: float,
    now: datetime,
    sleep: Callable[[float], None] = time.sleep,
    page_items: int = PAGE_ITEMS,
) -> Summary:
    """Write a `kind` snapshot of `table` taken at `now`, keep it as the monthly one if it's the
    month's first nightly, then copy the images `bucket` is missing from `images_bucket`.
    """
    items = scan_table(dynamodb, table, read_units, sleep=sleep, page_items=page_items)
    header = {
        "format": FORMAT,
        "version": VERSION,
        "schema_version": _schema_version(items),
        "table": table,
        "kind": kind,
        "taken_at": f"{now.astimezone(UTC):%Y-%m-%dT%H:%M:%SZ}",
        "items": len(items),
    }
    lines = [json.dumps(line, separators=(",", ":")) for line in [header, *items]]
    body = gzip.compress(("\n".join(lines) + "\n").encode(), mtime=0)
    key = snapshot_key(kind, now)
    s3.put_object(Bucket=bucket, Key=key, Body=body, ContentType="application/gzip")
    logger.info("Wrote %s: %d items", key, len(items))

    monthly = None
    month = f"snapshots/monthly/{now.astimezone(UTC):%Y-%m}-"
    if (
        kind == "nightly"
        and s3.list_objects_v2(Bucket=bucket, Prefix=month, MaxKeys=1).get("KeyCount", 0) == 0
    ):
        monthly = snapshot_key("monthly", now)
        s3.copy_object(Bucket=bucket, Key=monthly, CopySource={"Bucket": bucket, "Key": key})
        logger.info("Kept %s as the monthly snapshot", key)

    copied = 0 if images_bucket is None else copy_new_images(s3, images_bucket, bucket)
    return {"snapshot": key, "monthly": monthly, "items": len(items), "images_copied": copied}


def _keys(s3: S3Client, bucket: str, prefix: str) -> Iterator[str]:
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
        for listed in page.get("Contents", []):
            yield listed.get("Key", "")


def copy_new_images(s3: S3Client, images_bucket: str, bucket: str) -> int:
    """Copy each image missing from `bucket`. A stored image never changes (its key is its
    content hash), so one already there by key is up to date.
    """
    held = set(_keys(s3, bucket, IMAGES))
    copied = 0
    for key in _keys(s3, images_bucket, IMAGES):
        if key not in held:
            s3.copy_object(Bucket=bucket, Key=key, CopySource={"Bucket": images_bucket, "Key": key})
            copied += 1
    logger.info("Copied %d new images", copied)
    return copied


def latest_snapshot_key(s3: S3Client, bucket: str) -> str | None:
    """The newest snapshot of any kind, by the time in its name."""
    snapshots = [key for kind in KINDS for key in _keys(s3, bucket, f"snapshots/{kind}/")]
    return max(snapshots, key=lambda key: key.rsplit("/", 1)[1], default=None)


def handler(event: dict[str, Any], _context: object) -> Summary:
    kind = event.get("kind")
    if kind not in INVOKED_KINDS:
        msg = f"A snapshot is {' or '.join(INVOKED_KINDS)}, not {kind}"
        raise ValueError(msg)
    return take_snapshot(
        boto3.client("dynamodb"),
        boto3.client("s3"),
        table=os.environ["TABLE_NAME"],
        bucket=os.environ["BACKUP_BUCKET"],
        images_bucket=os.environ["IMAGES_BUCKET"],
        kind=kind,
        read_units=float(os.environ["SNAPSHOT_READ_UNITS"]),
        now=datetime.now(UTC),
    )
