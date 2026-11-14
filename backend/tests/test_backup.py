"""The Backup Snapshot: a paced Scan of the table into one gzipped JSON Lines file, plus the
images the backup bucket doesn't hold yet."""

import gzip
import json
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import boto3
import pytest

from recipes import backup
from recipes.store import SCHEMA_KEY, Store

if TYPE_CHECKING:
    from types_boto3_s3 import S3Client

    from recipes.images import ImageStore

BACKUP_BUCKET = "plateful-test-backup"
NOV_13 = datetime(2026, 11, 13, 3, 30, 5, tzinfo=UTC)
NOV_14 = datetime(2026, 11, 14, 3, 30, 5, tzinfo=UTC)
DEC_1 = datetime(2026, 12, 1, 3, 30, 5, tzinfo=UTC)


@pytest.fixture
def s3(table: str) -> S3Client:
    """An empty backup bucket on the same fake AWS."""
    client: S3Client = boto3.client("s3")
    client.create_bucket(
        Bucket=BACKUP_BUCKET, CreateBucketConfiguration={"LocationConstraint": "us-west-2"}
    )
    return client


def seed(table: str) -> list[dict[str, Any]]:
    """A bootstrapped table plus synthetic items with a string set and a number in them."""
    Store(table).bootstrap()
    client = boto3.client("dynamodb")
    for n in range(7):
        client.put_item(
            TableName=table,
            Item={
                "PK": {"S": f"TEST#{n}"},
                "SK": {"S": "TEST"},
                "ticks": {"SS": ["synthetic-a", f"synthetic-{n}"]},
                "count": {"N": "1.50"},
            },
        )
    return client.scan(TableName=table)["Items"]


def no_sleep(_seconds: float) -> None:
    pass


def take(table: str, kind: str, at: datetime, images_bucket: str | None = None) -> backup.Summary:
    return backup.take_snapshot(
        boto3.client("dynamodb"),
        boto3.client("s3"),
        table=table,
        bucket=BACKUP_BUCKET,
        images_bucket=images_bucket,
        kind=kind,
        read_units=1000.0,
        now=at,
        sleep=no_sleep,
    )


def read_lines(s3: S3Client, key: str) -> list[dict[str, Any]]:
    body = s3.get_object(Bucket=BACKUP_BUCKET, Key=key)["Body"].read()
    return [json.loads(line) for line in gzip.decompress(body).decode().splitlines()]


def keys(s3: S3Client, prefix: str) -> list[str]:
    listed = s3.list_objects_v2(Bucket=BACKUP_BUCKET, Prefix=prefix)
    return [o.get("Key", "") for o in listed.get("Contents", [])]


def test_a_snapshot_holds_every_item_exactly_as_dynamodb_has_it(table: str, s3: S3Client) -> None:
    items = seed(table)

    summary = take(table, "nightly", NOV_13)

    assert summary["snapshot"] == "snapshots/nightly/2026-11-13T033005Z.jsonl.gz"
    header, *lines = read_lines(s3, summary["snapshot"])
    schema = next(i for i in items if i["PK"] == SCHEMA_KEY["PK"])
    assert header == {
        "format": "plateful-backup",
        "version": 1,
        "schema_version": int(schema["schema_version"]["N"]),
        "table": table,
        "kind": "nightly",
        "taken_at": "2026-11-13T03:30:05Z",
        "items": len(items),
    }
    assert summary["items"] == len(items)

    def by_key(item: dict[str, Any]) -> str:
        return json.dumps([item["PK"], item["SK"]])

    assert sorted(lines, key=by_key) == sorted(items, key=by_key)
    tick = next(line for line in lines if line["PK"] == {"S": "TEST#3"})
    assert set(tick["ticks"]["SS"]) == {"synthetic-a", "synthetic-3"}
    assert tick["count"] == {"N": "1.50"}
    assert s3.head_object(Bucket=BACKUP_BUCKET, Key=summary["snapshot"])["ContentType"] == (
        "application/gzip"
    )


def test_an_empty_table_has_no_schema_version(table: str, s3: S3Client) -> None:
    summary = take(table, "pre-release", NOV_13)

    header, *lines = read_lines(s3, summary["snapshot"])
    assert header["schema_version"] is None
    assert header["items"] == 0
    assert lines == []


def test_the_scan_is_paced_to_the_read_units(table: str, s3: S3Client) -> None:
    seed(table)
    consumed: list[float] = []
    client = boto3.client("dynamodb")
    scan = client.scan

    def counting_scan(**kwargs: Any) -> Any:
        assert kwargs["ReturnConsumedCapacity"] == "TOTAL"
        page = scan(**kwargs)
        consumed.append(page["ConsumedCapacity"]["CapacityUnits"])
        return page

    client.scan = counting_scan  # type: ignore[method-assign]
    slept: list[float] = []

    backup.take_snapshot(
        client,
        s3,
        table=table,
        bucket=BACKUP_BUCKET,
        images_bucket=None,
        kind="nightly",
        read_units=2.0,
        now=NOV_13,
        sleep=slept.append,
        page_items=2,
    )

    assert len(consumed) >= 4
    assert sum(consumed) > 0
    assert sum(slept) >= sum(consumed) / 2.0


def test_throttled_pages_are_retried(table: str, s3: S3Client) -> None:
    seed(table)
    client = boto3.client("dynamodb")
    scan = client.scan
    throttles = [True, False, True]

    def throttling_scan(**kwargs: Any) -> Any:
        if throttles and throttles.pop(0):
            raise client.exceptions.ProvisionedThroughputExceededException(
                {"Error": {"Code": "ProvisionedThroughputExceededException"}}, "Scan"
            )
        return scan(**kwargs)

    client.scan = throttling_scan  # type: ignore[method-assign]

    items = backup.scan_table(client, table, 1000.0, sleep=no_sleep, page_items=3)

    assert throttles == []
    assert len(items) == len(scan(TableName=table)["Items"])


def test_the_first_nightly_of_a_month_is_kept_as_the_monthly(table: str, s3: S3Client) -> None:
    seed(table)

    first = take(table, "nightly", NOV_13)
    take(table, "nightly", NOV_14)
    take(table, "pre-release", DEC_1)
    december = take(table, "nightly", DEC_1.replace(hour=4))

    assert keys(s3, "snapshots/monthly/") == [
        "snapshots/monthly/2026-11-13T033005Z.jsonl.gz",
        "snapshots/monthly/2026-12-01T043005Z.jsonl.gz",
    ]
    assert first["monthly"] == "snapshots/monthly/2026-11-13T033005Z.jsonl.gz"
    assert december["monthly"] == "snapshots/monthly/2026-12-01T043005Z.jsonl.gz"
    monthly = read_lines(s3, "snapshots/monthly/2026-11-13T033005Z.jsonl.gz")
    assert monthly == read_lines(s3, first["snapshot"])


def test_only_missing_images_are_copied(table: str, images: ImageStore, s3: S3Client) -> None:
    for n in range(3):
        s3.put_object(Bucket=images.bucket, Key=f"images/{n:032x}.webp", Body=b"synthetic")
    s3.put_object(Bucket=images.bucket, Key="other/not-an-image", Body=b"synthetic")
    s3.put_object(Bucket=BACKUP_BUCKET, Key=f"images/{0:032x}.webp", Body=b"synthetic")

    first = take(table, "nightly", NOV_13, images_bucket=images.bucket)
    second = take(table, "nightly", NOV_14, images_bucket=images.bucket)

    assert first["images_copied"] == 2
    assert second["images_copied"] == 0
    assert keys(s3, "images/") == [f"images/{n:032x}.webp" for n in range(3)]
    assert keys(s3, "other/") == []


def test_the_latest_snapshot_is_the_newest_across_kinds(table: str, s3: S3Client) -> None:
    assert backup.latest_snapshot_key(s3, BACKUP_BUCKET) is None

    take(table, "nightly", NOV_13)
    take(table, "pre-release", NOV_14)
    take(table, "nightly", NOV_14.replace(hour=1))

    assert backup.latest_snapshot_key(s3, BACKUP_BUCKET) == (
        "snapshots/pre-release/2026-11-14T033005Z.jsonl.gz"
    )


def test_the_handler_rejects_an_unknown_kind(table: str, s3: S3Client) -> None:
    with pytest.raises(ValueError, match="monthly"):
        backup.handler({"kind": "monthly"}, None)


def test_the_handler_backs_up_the_stack_from_its_environment(
    table: str, images: ImageStore, s3: S3Client, monkeypatch: pytest.MonkeyPatch
) -> None:
    seed(table)
    s3.put_object(Bucket=images.bucket, Key=f"images/{1:032x}.webp", Body=b"synthetic")
    monkeypatch.setenv("TABLE_NAME", table)
    monkeypatch.setenv("IMAGES_BUCKET", images.bucket)
    monkeypatch.setenv("BACKUP_BUCKET", BACKUP_BUCKET)
    monkeypatch.setenv("SNAPSHOT_READ_UNITS", "1000")

    summary = backup.handler({"kind": "pre-release"}, None)

    assert summary["snapshot"].startswith("snapshots/pre-release/")
    assert summary["items"] > 7
    assert summary["images_copied"] == 1
    assert backup.latest_snapshot_key(s3, BACKUP_BUCKET) == summary["snapshot"]
    assert keys(s3, "snapshots/monthly/") == []
