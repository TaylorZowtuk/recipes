"""The Backup Snapshot: a paced Scan of the stack's table, written as one gzipped JSON Lines file
to the backup bucket, then a copy of every image the backup bucket doesn't hold yet.

A scheduled Lambda runs it nightly and before every release, with a plain Python handler. The
first nightly of each UTC month is also kept as that month's snapshot.

Line 1 of a snapshot is a header; every other line is one item exactly as DynamoDB's low-level
client returns it, so sets and numbers load unchanged into another stack's table. Each page of the
Scan is written to a gzipped file under the temp folder as it arrives, so the snapshot is never
all in memory, then uploaded.

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
import tempfile
import time
from datetime import UTC, datetime
from http import HTTPStatus
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any, Literal, TypedDict
from urllib.parse import urlencode

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
    from types_boto3_s3.type_defs import ListObjectsV2RequestTypeDef

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
# A presigned link is about 1.7 KB, so a page stays well under Lambda's 6 MB response limit.
IMAGE_LINKS_PER_PAGE = 500
CHUNK_BYTES = 64 * 1024
# The metric the stack's stale backup alarm watches (modules/backup): one per completed nightly
# snapshot, by function. Pre-release runs don't count, so they can't hide a schedule that stopped.
METRIC_NAMESPACE = "Plateful"
NIGHTLY_METRIC = "NightlyBackupSnapshots"


class Summary(TypedDict):
    backup_snapshot: str
    monthly: str | None
    items: int
    images_copied: int


def snapshot_key(kind: str, at: datetime) -> str:
    return f"snapshots/{kind}/{at.astimezone(UTC):%Y-%m-%dT%H%M%SZ}.jsonl.gz"


def scan_pages(
    client: DynamoDBClient,
    table: str,
    read_units: float,
    *,
    sleep: Callable[[float], None] = time.sleep,
    page_items: int | None = None,
) -> Iterator[list[Item]]:
    """Every item, eventually consistent, a page at a time: pages of about one second's reads
    (or `page_items`), sleeping after each page so the average read rate stays at or under
    `read_units` per second.
    """
    request: ScanInputTypeDef = {
        "TableName": table,
        "Limit": page_items or max(1, int(read_units * ITEMS_PER_READ_UNIT)),
        "ReturnConsumedCapacity": "TOTAL",
    }
    while True:
        page = _scan_page(client, request, sleep)
        yield page["Items"]
        sleep(page.get("ConsumedCapacity", {}).get("CapacityUnits", 0) / read_units)
        if "LastEvaluatedKey" not in page:
            return
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


def _schema_version(client: DynamoDBClient, table: str) -> int | None:
    item = client.get_item(TableName=table, Key=SCHEMA_KEY).get("Item")
    return None if item is None else int(item["schema_version"].get("N", ""))


def take_snapshot(
    dynamodb: DynamoDBClient,
    s3: S3Client,
    *,
    table: str,
    bucket: str,
    images_bucket: str,
    kind: str,
    read_units: float,
    now: datetime,
    sleep: Callable[[float], None] = time.sleep,
    page_items: int | None = None,
) -> Summary:
    """Write a `kind` snapshot of `table` taken at `now`, keep it as the monthly one if it's the
    month's first nightly, then copy the images `bucket` is missing from `images_bucket`.
    """
    header = {
        "format": FORMAT,
        "version": VERSION,
        "schema_version": _schema_version(dynamodb, table),
        "table": table,
        "kind": kind,
        "taken_at": f"{now.astimezone(UTC):%Y-%m-%dT%H:%M:%SZ}",
    }
    key = snapshot_key(kind, now)
    items = 0
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "snapshot.jsonl.gz"
        with path.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as file:
            file.write(_line(header))
            for page in scan_pages(dynamodb, table, read_units, sleep=sleep, page_items=page_items):
                file.writelines(_line(item) for item in page)
                items += len(page)
        s3.upload_file(str(path), bucket, key, ExtraArgs={"ContentType": "application/gzip"})
    logger.info("Wrote %s: %d items", key, items)

    monthly = None
    month = f"snapshots/monthly/{now.astimezone(UTC):%Y-%m}-"
    if (
        kind == "nightly"
        and s3.list_objects_v2(Bucket=bucket, Prefix=month, MaxKeys=1).get("KeyCount", 0) == 0
    ):
        monthly = snapshot_key("monthly", now)
        s3.copy_object(Bucket=bucket, Key=monthly, CopySource={"Bucket": bucket, "Key": key})
        logger.info("Kept %s as the monthly snapshot", key)

    copied = copy_new_images(s3, images_bucket, bucket)
    return {"backup_snapshot": key, "monthly": monthly, "items": items, "images_copied": copied}


def _line(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":")).encode() + b"\n"


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
    """Download links into the backup bucket, each good for `expires_in` seconds: the latest
    Backup Snapshot and one page of images. `next` is the `after` for the next page, or None on
    the last.
    """

    backup_snapshot: BackupLink | None
    images: list[BackupLink]
    next: str | None
    expires_in: int


class BackupBucket:
    """The stack's backup bucket, which the API hands editors short-lived download links into."""

    def __init__(self, bucket: str, client: S3Client | None = None) -> None:
        self.bucket = bucket
        self.images_per_page = IMAGE_LINKS_PER_PAGE
        # Signature Version 4, which every region accepts, on the bucket's regional endpoint.
        self.client: S3Client = client or boto3.client(
            "s3", config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"})
        )

    @classmethod
    def from_env(cls) -> BackupBucket:
        return cls(os.environ["BACKUP_BUCKET"])

    def links(self, after: str | None = None) -> BackupLinks:
        """Links to the latest snapshot and a page of the backed-up images whose keys sort
        after `after`.
        """

        def link(key: str) -> BackupLink:
            url = self.client.generate_presigned_url(
                "get_object",
                Params={"Bucket": self.bucket, "Key": key},
                ExpiresIn=LINK_SECONDS,
            )
            return BackupLink(key=key, url=url)

        latest = latest_snapshot_key(self.client, self.bucket)
        request: ListObjectsV2RequestTypeDef = {
            "Bucket": self.bucket,
            "Prefix": IMAGES,
            "MaxKeys": self.images_per_page,
        }
        if after is not None:
            request["StartAfter"] = after
        page = self.client.list_objects_v2(**request)
        keys = [listed.get("Key", "") for listed in page.get("Contents", [])]
        return BackupLinks(
            backup_snapshot=None if latest is None else link(latest),
            images=[link(key) for key in keys],
            next=keys[-1] if page.get("IsTruncated") and keys else None,
            expires_in=LINK_SECONDS,
        )


type Saved = Literal["saved", "present", "failed"]


def pull(base_url: str, send: Send, download: requests.Session, to: Path) -> bool:
    """Save the latest snapshot and each image not already in `to`, at its key under `to`,
    downloading each page of links before asking for the next, so no link goes stale.
    `download` never carries the service token. True if anything failed.
    """
    try:
        to.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        print(f"Couldn't make the folder {to}: {error.strerror}", file=sys.stderr)
        return True
    links = _links(base_url, send, None)
    if links is None:
        return True

    failed = not _save_snapshot(download, links.backup_snapshot, to)
    counts = {"saved": 0, "present": 0, "failed": 0}
    while True:
        for image in links.images:
            counts[_save(download, image, to)] += 1
        if links.next is None:
            break
        links = _links(base_url, send, links.next)
        if links is None:
            failed = True
            break
    print(
        f"Images: {counts['saved']} downloaded, {counts['present']} already here, "
        f"{counts['failed']} failed"
    )
    return failed or counts["failed"] > 0


def _save_snapshot(download: requests.Session, link: BackupLink | None, to: Path) -> bool:
    """Save the Backup Snapshot at `link`, if there is one. False if that failed."""
    if link is None:
        print("No Backup Snapshot to save yet")
        return True
    match _save(download, link, to):
        case "saved":
            print(f"Saved the Backup Snapshot {link.key}")
        case "present":
            print(f"Already have the Backup Snapshot {link.key}")
        case "failed":
            return False
    return True


def _links(base_url: str, send: Send, after: str | None) -> BackupLinks | None:
    """A page of download links, or None (having said why) if there are none to be had."""
    query = "" if after is None else f"?{urlencode({'after': after})}"
    try:
        status, body = send("GET", f"{base_url}/api/backup/links{query}", None)
    except requests.RequestException as error:
        # Only the error's kind: its message holds the URL.
        print(f"Couldn't get the download links: {type(error).__name__}", file=sys.stderr)
        return None
    if status != HTTPStatus.OK:
        print(f"Couldn't get the download links: {status} {body}", file=sys.stderr)
        return None
    try:
        return BackupLinks.model_validate(body)
    except ValidationError as error:
        # Only where: the input in its message holds the links.
        wrong = ", ".join(".".join(map(str, e["loc"])) or "the body" for e in error.errors())
        print(f"The download links aren't as expected: {wrong}", file=sys.stderr)
        return None


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
    part = path.with_name(f".{path.name}.part")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
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
    summary = take_snapshot(
        boto3.client("dynamodb"),
        boto3.client("s3"),
        table=os.environ["TABLE_NAME"],
        bucket=os.environ["BACKUP_BUCKET"],
        images_bucket=os.environ["IMAGES_BUCKET"],
        kind=kind,
        read_units=float(os.environ["SNAPSHOT_READ_UNITS"]),
        now=datetime.now(UTC),
    )
    if kind == "nightly":
        _count_nightly(os.environ["AWS_LAMBDA_FUNCTION_NAME"])
    return summary


def _count_nightly(function_name: str) -> None:
    """Count a completed nightly snapshot, its images copied too, in the Embedded Metric Format:
    CloudWatch Logs turns this one JSON line on stdout into the metric, so the function needs no
    PutMetricData. A logger line wouldn't do: Lambda's text format puts a prefix before it.
    """
    line = {
        "_aws": {
            "Timestamp": int(time.time() * 1000),
            "CloudWatchMetrics": [
                {
                    "Namespace": METRIC_NAMESPACE,
                    "Dimensions": [["FunctionName"]],
                    "Metrics": [{"Name": NIGHTLY_METRIC, "Unit": "Count"}],
                }
            ],
        },
        "FunctionName": function_name,
        NIGHTLY_METRIC: 1,
    }
    print(json.dumps(line, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
