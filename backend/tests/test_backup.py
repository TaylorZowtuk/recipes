"""The Backup Snapshot: a paced Scan of the table into one gzipped JSON Lines file, plus the
images the backup bucket doesn't hold yet."""

import gzip
import json
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from urllib.parse import parse_qs, urlsplit

import boto3
import pytest
import requests
from conftest import BACKUP_BUCKET, EDITOR
from requests.adapters import HTTPAdapter
from test_enrich import Adapter, api, through

from recipes import backup
from recipes.auth import SERVICE_TOKEN_HEADER
from recipes.store import SCHEMA_KEY, Store

if TYPE_CHECKING:
    from pathlib import Path

    from fastapi.testclient import TestClient
    from requests.models import PreparedRequest, Response
    from types_boto3_s3 import S3Client

    from recipes.backup import BackupBucket
    from recipes.client import Send
    from recipes.images import ImageStore

NOV_13 = datetime(2026, 11, 13, 3, 30, 5, tzinfo=UTC)
NOV_14 = datetime(2026, 11, 14, 3, 30, 5, tzinfo=UTC)
DEC_1 = datetime(2026, 12, 1, 3, 30, 5, tzinfo=UTC)


@pytest.fixture
def s3(backups: BackupBucket) -> S3Client:
    """The client on fake AWS, with an empty backup bucket."""
    return backups.client


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


@pytest.mark.parametrize(("read_units", "limit"), [(5.0, 10), (2.0, 4), (0.2, 1)])
def test_a_page_reads_about_one_second_of_the_pace(
    table: str, read_units: float, limit: int
) -> None:
    """At two items of up to 4 KB to an eventually consistent read unit, a page never bursts
    far past the pace the way a fixed 100 items would.
    """
    seed(table)
    client = boto3.client("dynamodb")
    scan = client.scan
    limits: list[int] = []

    def recording_scan(**kwargs: Any) -> Any:
        limits.append(kwargs["Limit"])
        return scan(**kwargs)

    client.scan = recording_scan  # type: ignore[method-assign]

    backup.scan_table(client, table, read_units, sleep=no_sleep)

    assert set(limits) == {limit}


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


# Download links


def image_keys(n: int) -> list[str]:
    """`n` images and their cards, in the order S3 lists them."""
    return sorted(f"images/{i:032x}{card}.webp" for i in range(n) for card in ("", "-card"))


def put_images(s3: S3Client, keys: list[str]) -> None:
    for key in keys:
        s3.put_object(Bucket=BACKUP_BUCKET, Key=key, Body=f"synthetic {key}".encode())


def test_an_empty_backup_bucket_has_no_links(editor_client: TestClient, s3: S3Client) -> None:
    response = editor_client.get("/api/backup/links", headers=EDITOR)

    assert response.status_code == 200
    assert response.json() == {"snapshot": None, "images": [], "expires_in": 900}


def test_links_are_to_the_latest_snapshot_and_every_backed_up_image(
    table: str, s3: S3Client, editor_client: TestClient
) -> None:
    seed(table)
    take(table, "nightly", NOV_13)
    latest = take(table, "pre-release", NOV_14)["snapshot"]
    put_images(s3, image_keys(2))

    links = editor_client.get("/api/backup/links", headers=EDITOR).json()

    assert links["expires_in"] == 900
    assert links["snapshot"]["key"] == latest
    assert [image["key"] for image in links["images"]] == image_keys(2)
    for link in [links["snapshot"], *links["images"]]:
        url = urlsplit(str(link["url"]))
        assert url.scheme == "https"
        assert (url.hostname or "").startswith(f"{BACKUP_BUCKET}.s3.")
        assert url.path == f"/{link['key']}"
        assert parse_qs(url.query)["X-Amz-Expires"] == ["900"]
    downloaded = requests.get(links["snapshot"]["url"], timeout=10)
    assert downloaded.content == s3.get_object(Bucket=BACKUP_BUCKET, Key=latest)["Body"].read()


# backup pull


class Downloads(HTTPAdapter):
    """The download session's transport: moto answers it, and it keeps every request."""

    def __init__(self) -> None:
        super().__init__()
        self.requests: list[PreparedRequest] = []

    def send(self, request: PreparedRequest, *args: Any, **kwargs: Any) -> Response:
        self.requests.append(request)
        return super().send(request, *args, **kwargs)


@pytest.fixture
def downloads() -> Downloads:
    return Downloads()


@pytest.fixture
def send(editor_client: TestClient) -> Send:
    return through(api(editor_client))


def pull(send: Send, downloads: Downloads, to: Path) -> bool:
    with requests.Session() as session:
        session.mount("https://", downloads)
        return backup.pull("http://testserver", send, session, to)


def test_pull_saves_the_latest_snapshot_and_then_only_whats_missing(
    table: str,
    s3: S3Client,
    send: Send,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    seed(table)
    snapshot = take(table, "nightly", NOV_13)["snapshot"]
    put_images(s3, image_keys(2))
    downloads = Downloads()

    assert pull(send, downloads, tmp_path) is False
    assert f"Saved the Backup Snapshot {snapshot}" in capsys.readouterr().out
    saved = (tmp_path / snapshot).read_bytes()
    assert saved == s3.get_object(Bucket=BACKUP_BUCKET, Key=snapshot)["Body"].read()
    for key in image_keys(2):
        assert (tmp_path / key).read_bytes() == f"synthetic {key}".encode()
    assert len(downloads.requests) == 5

    put_images(s3, image_keys(3))
    assert pull(send, downloads, tmp_path) is False

    printed = capsys.readouterr().out
    assert f"Already have the Backup Snapshot {snapshot}" in printed
    assert "Downloaded 2 images, 4 already here" in printed
    assert len(downloads.requests) == 7
    assert sorted(p.name for p in tmp_path.rglob("*") if p.is_file()) == sorted(
        [snapshot.rsplit("/", 1)[1], *(key.removeprefix("images/") for key in image_keys(3))]
    )


def test_pull_never_downloads_an_image_already_saved(
    s3: S3Client, send: Send, downloads: Downloads, tmp_path: Path
) -> None:
    keys = image_keys(1)
    put_images(s3, keys)
    (tmp_path / "images").mkdir()
    (tmp_path / keys[0]).write_bytes(b"saved earlier")

    assert pull(send, downloads, tmp_path) is False

    assert (tmp_path / keys[0]).read_bytes() == b"saved earlier"
    assert [urlsplit(r.url or "").path for r in downloads.requests] == [f"/{keys[1]}"]


def test_pull_sends_the_service_token_to_the_api_only(
    table: str, s3: S3Client, editor_client: TestClient, downloads: Downloads, tmp_path: Path
) -> None:
    seed(table)
    take(table, "nightly", NOV_13)
    put_images(s3, image_keys(1))
    to_api = api(editor_client)

    assert pull(through(to_api), downloads, tmp_path) is False

    assert [r.headers[SERVICE_TOKEN_HEADER] for r in to_api.requests] == ["synthetic-service-token"]
    assert len(downloads.requests) == 3
    for request in downloads.requests:
        assert SERVICE_TOKEN_HEADER not in request.headers
        assert "x-amz-content-sha256" not in request.headers


@pytest.mark.parametrize(
    "key", ["images/../../escaped.webp", "/etc/escaped", "snapshots/../../escaped", "other/x"]
)
def test_pull_refuses_a_key_outside_its_folder(
    key: str, downloads: Downloads, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    link = {"key": key, "url": f"https://{BACKUP_BUCKET}.s3.amazonaws.com/escaped"}

    def send(_method: str, _url: str, _body: bytes | None) -> tuple[int, Any]:
        return 200, {"snapshot": None, "images": [link], "expires_in": 900}

    to = tmp_path / "backups"
    to.mkdir()

    assert pull(send, downloads, to) is True

    assert downloads.requests == []
    assert [p for p in tmp_path.rglob("*") if p.is_file()] == []
    assert f"Refused {key!r}" in capsys.readouterr().err


def test_an_interrupted_download_leaves_no_file_to_skip_next_time(
    s3: S3Client, send: Send, tmp_path: Path
) -> None:
    keys = image_keys(1)
    put_images(s3, keys)

    class Broken:
        """Gives the first bytes, then the connection drops."""

        def __init__(self) -> None:
            self.reads = 0

        def read(self, *_args: Any, **_kwargs: Any) -> bytes:
            self.reads += 1
            if self.reads > 1:
                raise OSError
            return b"synthetic part"

        def close(self) -> None:
            pass

    def cut_off(request: PreparedRequest) -> tuple[int, dict[str, str], bytes]:
        return 200, {}, b""

    broken = Adapter(cut_off)
    real_send = broken.send

    def send_broken(request: PreparedRequest, *args: Any, **kwargs: Any) -> Response:
        response = real_send(request, *args, **kwargs)
        response.raw = Broken()
        return response

    broken.send = send_broken  # type: ignore[method-assign]
    with requests.Session() as session:
        session.mount("https://", broken)
        assert backup.pull("http://testserver", send, session, tmp_path) is True

    assert [p for p in tmp_path.rglob("*") if p.is_file()] == []

    downloads = Downloads()
    assert pull(send, downloads, tmp_path) is False
    assert len(downloads.requests) == 2
