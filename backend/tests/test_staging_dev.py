"""The API as `make dev STAGING_PROFILE=…` runs it: the stack's API, plus `/images/*` from the
images bucket, which CloudFront serves on a stack.
"""

from typing import TYPE_CHECKING

import pytest
from fake_web import photo
from fastapi.testclient import TestClient

from recipes import api, staging

if TYPE_CHECKING:
    from recipes.images import ImageStore


@pytest.fixture
def stack_env(monkeypatch: pytest.MonkeyPatch, table: str, images: ImageStore) -> None:
    monkeypatch.setenv("TABLE_NAME", table)
    monkeypatch.setenv("IMAGES_BUCKET", images.bucket)
    monkeypatch.setenv("SSM_PREFIX", "/plateful/test/")


@pytest.mark.usefixtures("stack_env")
def test_staging_dev_serves_a_stored_image_with_its_content_type_and_cache_control(
    images: ImageStore,
) -> None:
    image = images.put(photo(), origin="https://plateful.test/photos/miso-soup.png")

    with TestClient(staging.app) as client:
        served = client.get(f"/images/{image.id}-card.webp")
        missing = client.get("/images/0000-card.webp")

    assert served.status_code == 200
    assert served.headers["content-type"] == "image/webp"
    assert served.headers["cache-control"] == "public, max-age=31536000, immutable"
    stored = images.client.get_object(Bucket=images.bucket, Key=f"images/{image.id}-card.webp")
    assert served.content == stored["Body"].read()
    assert missing.status_code == 404


@pytest.mark.usefixtures("stack_env")
def test_the_stacks_api_has_no_images_route(images: ImageStore) -> None:
    image = images.put(photo(), origin="https://plateful.test/photos/miso-soup.png")

    with TestClient(api.app) as client:
        assert client.get(f"/images/{image.id}-card.webp").status_code == 404
