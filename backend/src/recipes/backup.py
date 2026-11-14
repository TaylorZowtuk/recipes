"""The Backup Snapshot: a paced Scan of the stack's table, written as one gzipped JSON Lines file
to the backup bucket, then a copy of every image the backup bucket doesn't hold yet.

A scheduled Lambda runs it nightly and before every release, with a plain Python handler. The
first nightly of each UTC month is also kept as that month's snapshot.

Line 1 of a snapshot is a header; every other line is one item exactly as DynamoDB's low-level
client returns it, so sets and numbers load unchanged into another stack's table.

Once a month an editor pulls the latest snapshot and the images not yet saved to a folder the
household controls, through the API's short-lived download links:

PLATEFUL_SERVICE_TOKEN=… uv run python -m recipes.backup pull <API base URL> --to <folder>
"""

import argparse
import gzip
import json
import logging
import os
import random
import sys
import time
from datetime import UTC, datetime
from http import HTTPStatus
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any, Literal, TypedDict

import boto3
import requests
from botocore.config import Config
from botocore.exceptions import ClientError
from pydantic import BaseModel, ValidationError

from recipes.client import SERVICE_TOKEN_ENV, SameOriginSession, checked_base_url, send_with
from recipes.store import SCHEMA_KEY

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    from types_boto3_dynamodb import DynamoDBClient
    from types_boto3_dynamodb.type_defs import ScanInputTypeDef, ScanOutputTypeDef
    from types_boto3_s3 import S3Client

    from recipes.client import Send
    from recipes.store import Item

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# The kinds the Lambda is invoked with. Monthly snapshots are copies of a nightly one.
INVOKED_KINDS = ("nightly", "pre-release")
KINDS = (*INVOKED_KINDS, "monthly")
FORMAT = "plateful-backup"
VERSION = 1
# An eventually consistent read unit reads 8 KB: about two items, a recipe being up to about
# 4 KB. A page of read_units * 2 items reads about one second of the pace, never a burst past it.
ITEMS_PER_READ_UNIT = 2
ATTEMPTS = 6
BACKOFF_SECONDS = 0.5
THROTTLED = {"ProvisionedThroughputExceededException", "ThrottlingException"}
IMAGES = "images/"
LINK_SECONDS = 15 * 60
CHUNK_BYTES = 64 * 1024


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
    page_items: int | None = None,
) -> list[Item]:
    """Every item, eventually consistent, in pages of about one second's reads (or
    `page_items`), sleeping after each page so the average read rate stays at or under
    `read_units` per second.
    """
    items: list[Item] = []
    request: ScanInputTypeDef = {
        "TableName": table,
        "Limit": page_items or max(1, int(read_units * ITEMS_PER_READ_UNIT)),
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
    page_items: int | None = None,
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


class BackupLink(BaseModel):
    key: str
    url: str


class BackupLinks(BaseModel):
    """Download links into the backup bucket, each good for `expires_in` seconds."""

    snapshot: BackupLink | None
    images: list[BackupLink]
    expires_in: int


class BackupBucket:
    """The stack's backup bucket, which the API hands editors short-lived download links into."""

    def __init__(self, bucket: str, client: S3Client | None = None) -> None:
        self.bucket = bucket
        # Signature Version 4, which every region accepts, on the bucket's regional endpoint.
        self.client: S3Client = client or boto3.client(
            "s3", config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"})
        )

    @classmethod
    def from_env(cls) -> BackupBucket:
        return cls(os.environ["BACKUP_BUCKET"])

    def links(self) -> BackupLinks:
        """Links to the latest snapshot and every backed-up image."""

        def link(key: str) -> BackupLink:
            url = self.client.generate_presigned_url(
                "get_object",
                Params={"Bucket": self.bucket, "Key": key},
                ExpiresIn=LINK_SECONDS,
            )
            return BackupLink(key=key, url=url)

        latest = latest_snapshot_key(self.client, self.bucket)
        return BackupLinks(
            snapshot=None if latest is None else link(latest),
            images=[link(key) for key in _keys(self.client, self.bucket, IMAGES)],
            expires_in=LINK_SECONDS,
        )


type Saved = Literal["saved", "present", "failed"]


def pull(base_url: str, send: Send, download: requests.Session, to: Path) -> bool:
    """Save the latest snapshot and each image not already in `to`, at its key under `to`.
    `download` never carries the service token. True if anything failed.
    """
    status, body = send("GET", f"{base_url}/api/backup/links", None)
    if status != HTTPStatus.OK:
        print(f"Couldn't get the download links: {status} {body}", file=sys.stderr)
        return True
    try:
        links = BackupLinks.model_validate(body)
    except ValidationError as error:
        print(f"The download links aren't as expected: {error}", file=sys.stderr)
        return True

    failed = False
    if links.snapshot is None:
        print("No Backup Snapshot to save yet")
    else:
        match _save(download, links.snapshot, to):
            case "saved":
                print(f"Saved the Backup Snapshot {links.snapshot.key}")
            case "present":
                print(f"Already have the Backup Snapshot {links.snapshot.key}")
            case "failed":
                failed = True
    counts = {"saved": 0, "present": 0, "failed": 0}
    for image in links.images:
        counts[_save(download, image, to)] += 1
    print(
        f"Downloaded {counts['saved']} images, {counts['present']} already here, "
        f"{counts['failed']} failed"
    )
    return failed or counts["failed"] > 0


def _local_path(to: Path, key: str) -> Path | None:
    """Where `key` is saved under `to`, or None if it would land anywhere else."""
    path = PurePosixPath(key)
    if (
        path.is_absolute()
        or not key.startswith(("snapshots/", IMAGES))
        or any(part in {"..", "."} for part in path.parts)
    ):
        return None
    return to.joinpath(*path.parts)


def _save(download: requests.Session, link: BackupLink, to: Path) -> Saved:
    """Download `link` unless it's already saved, through a part file renamed into place once
    complete, so an interrupted download never leaves a file a later run would skip.
    """
    path = _local_path(to, link.key)
    if path is None:
        print(f"Refused {link.key!r}: it isn't a snapshot or an image", file=sys.stderr)
        return "failed"
    if path.exists():
        return "present"
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_name(f".{path.name}.part")
    try:
        with download.get(link.url, stream=True, timeout=60) as response:
            if response.status_code != HTTPStatus.OK:
                print(f"Couldn't download {link.key}: {response.status_code}", file=sys.stderr)
                return "failed"
            with part.open("wb") as file:
                for chunk in response.iter_content(CHUNK_BYTES):
                    file.write(chunk)
                file.flush()
                os.fsync(file.fileno())
        part.replace(path)
    except (requests.RequestException, OSError) as error:
        # Only the error's kind: its message can hold the link, which is a credential until it
        # expires.
        print(f"Couldn't download {link.key}: {type(error).__name__}", file=sys.stderr)
        part.unlink(missing_ok=True)
        return "failed"
    return "saved"


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m recipes.backup", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    pull_command = commands.add_parser(
        "pull", help="save the latest Backup Snapshot and the images not yet saved"
    )
    pull_command.add_argument("base_url", help="the API's base URL, e.g. http://localhost:5173")
    pull_command.add_argument("--to", required=True, help="the folder to save into")
    args = parser.parse_args(argv)
    base_url = checked_base_url(args.base_url)
    token = os.environ.get(SERVICE_TOKEN_ENV)
    if not token:
        sys.exit(f"Set {SERVICE_TOKEN_ENV} to the stack's service token")
    with SameOriginSession() as session, requests.Session() as download:
        failed = pull(base_url, send_with(session, token), download, Path(args.to))
    sys.exit(1 if failed else 0)


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


if __name__ == "__main__":
    main()
