"""The Lambda zip that `make lambda` builds, and the run.sh handler inside it."""

import hashlib
import http.client
import os
import socket
import subprocess
import sys
import time
import zipfile
from pathlib import Path
from typing import TYPE_CHECKING

import boto3
import pytest
from moto.server import ThreadedMotoServer

from recipes.store import create_table

if TYPE_CHECKING:
    from collections.abc import Iterator

REPO = Path(__file__).resolve().parents[2]
RUN_SH = REPO / "backend" / "lambda" / "run.sh"
BUILD = REPO / "scripts" / "lambda.sh"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def get(port: int, path: str) -> tuple[int, bytes]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
    try:
        conn.request("GET", path)
        response = conn.getresponse()
        return response.status, response.read()
    finally:
        conn.close()


@pytest.fixture
def dynamodb() -> Iterator[dict[str, str]]:
    """A DynamoDB outside this process, on moto's server, holding an empty table shaped like a
    stack's: the environment that points boto3 at it.
    """
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=free_port())
    server.start()
    host, port = server.get_host_and_port()
    env = {
        "AWS_ENDPOINT_URL": f"http://{host}:{port}",
        "AWS_ACCESS_KEY_ID": "testing",
        "AWS_SECRET_ACCESS_KEY": "testing",
        "AWS_DEFAULT_REGION": "us-west-2",
        "TABLE_NAME": "plateful-test",
    }
    client = boto3.client(
        "dynamodb",
        endpoint_url=env["AWS_ENDPOINT_URL"],
        region_name=env["AWS_DEFAULT_REGION"],
        aws_access_key_id=env["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=env["AWS_SECRET_ACCESS_KEY"],
    )
    create_table(client, env["TABLE_NAME"])
    yield env
    server.stop()


def test_run_sh_serves_the_api_on_port_with_the_stack_variables_set(
    dynamodb: dict[str, str],
) -> None:
    port = free_port()
    env = {
        **os.environ,
        **dynamodb,
        "PATH": f"{Path(sys.executable).parent}{os.pathsep}{os.environ['PATH']}",
        "PORT": str(port),
        "IMAGES_BUCKET": "plateful-test-images",
        "SSM_PREFIX": "/plateful/test/",
    }
    server = subprocess.Popen([RUN_SH], env=env)
    try:
        deadline = time.monotonic() + 10
        while True:
            try:
                status, body = get(port, "/api/sync")
                break
            except OSError:
                assert server.poll() is None, "run.sh exited before serving"
                assert time.monotonic() < deadline, "run.sh never started listening"
                time.sleep(0.1)
        assert status == 200
        assert b'"schema_version":1' in body
        assert b'"collection_version":1' in body, "the lifespan should bootstrap the empty table"
    finally:
        server.terminate()
        server.wait(timeout=10)


@pytest.fixture(scope="module")
def lambda_zips(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, Path]:
    out = tmp_path_factory.mktemp("lambda")
    first, second = out / "first.zip", out / "second.zip"
    for zip_path in (first, second):
        subprocess.run([BUILD, zip_path], check=True)
    return first, second


def test_lambda_zip_builds_byte_for_byte_the_same_twice(lambda_zips: tuple[Path, Path]) -> None:
    first, second = lambda_zips
    digest = [hashlib.sha256(p.read_bytes()).hexdigest() for p in (first, second)]
    assert digest[0] == digest[1]


def test_lambda_zip_holds_the_handler_the_package_and_arm64_runtime_deps(
    lambda_zips: tuple[Path, Path],
) -> None:
    with zipfile.ZipFile(lambda_zips[0]) as zf:
        infos = {info.filename: info for info in zf.infolist()}

    run_sh = infos["run.sh"]
    assert (run_sh.external_attr >> 16) & 0o777 == 0o755
    for name in ("recipes/__init__.py", "recipes/api.py", "fastapi/__init__.py"):
        assert name in infos
    assert "uvicorn/__init__.py" in infos
    assert any(
        name.startswith("pydantic_core/") and "aarch64-linux-gnu" in name and name.endswith(".so")
        for name in infos
    ), "pydantic_core should be the Linux arm64 build"

    top_level = {name.split("/", 1)[0] for name in infos}
    for dev_only in ("pytest", "moto", "ruff", "pyright", "bin", ".lock"):
        assert dev_only not in top_level
    assert not any("__pycache__" in name for name in infos)
