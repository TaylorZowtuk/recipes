"""The Lambda zip that `make lambda` builds, and the run.sh handler inside it."""

import hashlib
import http.client
import os
import platform
import shutil
import socket
import subprocess
import sys
import sysconfig
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


# Under pytest-xdist each worker would build its own pair of zips, so the tests that use them run
# on one worker (`--dist loadgroup`), which builds them once.
lambda_zip = pytest.mark.xdist_group("lambda_zip")


@pytest.fixture(scope="module")
def lambda_zips(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, Path]:
    out = tmp_path_factory.mktemp("lambda")
    first, second = out / "first.zip", out / "second.zip"
    # Two independent builds, each in its own staging directory, run side by side.
    builds = [subprocess.Popen([BUILD, zip_path]) for zip_path in (first, second)]
    assert [build.wait() for build in builds] == [0, 0]
    return first, second


@lambda_zip
def test_lambda_zip_builds_byte_for_byte_the_same_twice(lambda_zips: tuple[Path, Path]) -> None:
    first, second = lambda_zips
    digest = [hashlib.sha256(p.read_bytes()).hexdigest() for p in (first, second)]
    assert digest[0] == digest[1]


@lambda_zip
def test_lambda_zip_holds_the_handler_the_package_and_arm64_runtime_deps(
    lambda_zips: tuple[Path, Path],
) -> None:
    with zipfile.ZipFile(lambda_zips[0]) as zf:
        infos = {info.filename: info for info in zf.infolist()}

    run_sh = infos["run.sh"]
    assert (run_sh.external_attr >> 16) & 0o777 == 0o755
    for name in (
        "recipes/__init__.py",
        "recipes/api.py",
        "recipes/kill_switch.py",
        "fastapi/__init__.py",
    ):
        assert name in infos
    for name in ("uvicorn/__init__.py", "recipe_scrapers/__init__.py", "protego/__init__.py"):
        assert name in infos
    assert "jstyleson.py" in infos, "built from its source distribution"
    for compiled in ("pydantic_core", "lxml"):
        assert any(
            name.startswith(f"{compiled}/") and "aarch64-linux-gnu" in name and name.endswith(".so")
            for name in infos
        ), f"{compiled} should be the Linux arm64 build"
    # Pillow's wheel builds WebP into its own extension, which stores every recipe photo.
    assert any(name.startswith("PIL/_webp.") and "aarch64-linux-gnu" in name for name in infos), (
        "Pillow should have its arm64 WebP codec"
    )

    top_level = {name.split("/", 1)[0] for name in infos}
    for dev_only in ("pytest", "moto", "ruff", "pyright", "bin", ".lock"):
        assert dev_only not in top_level
    for enrich_only in ("ingredient_parser", "nltk", "pint", "numpy"):
        assert enrich_only not in top_level, (
            "the enrich group stays out of the zip for now: the Our Version ticket decides "
            "whether the API parses lines on save"
        )
    assert not any("__pycache__" in name for name in infos)


# recipe_scrapers too, which the API imports only on its first parse, with its dependencies.
IMPORT_FROM_ARGV = "import sys; sys.path[:0] = sys.argv[1:]; import recipes.api, recipe_scrapers"


@lambda_zip
def test_the_api_imports_from_the_zip_without_installed_package_metadata(
    lambda_zips: tuple[Path, Path], tmp_path: Path
) -> None:
    """The zip holds `recipes` without its dist-info, so importing the API and its scrapers
    mustn't need it. The arm64 extensions can't load here, so those packages come from this
    venv's own builds instead, linked into a directory that holds nothing else.
    """
    tree, native = tmp_path / "tree", tmp_path / "native"
    native.mkdir()
    with zipfile.ZipFile(lambda_zips[0]) as zf:
        zf.extractall(tree)
    site_packages = Path(sysconfig.get_paths()["purelib"])
    arm64 = {path.relative_to(tree).parts[0] for path in tree.rglob("*.so")}
    for name in arm64:
        shutil.rmtree(tree / name) if (tree / name).is_dir() else (tree / name).unlink()
        local = name.replace("aarch64", platform.machine())
        (native / local).symlink_to(site_packages / local)

    imported = subprocess.run(
        [sys.executable, "-I", "-S", "-c", IMPORT_FROM_ARGV, tree, native],
        capture_output=True,
        text=True,
        check=False,
    )

    assert imported.returncode == 0, imported.stderr
