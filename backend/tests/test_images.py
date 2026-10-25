"""Recipe photos in the images bucket: each stored once as WebP, with its card-size copy."""

import hashlib
import io
from typing import TYPE_CHECKING, Any

import pytest
from fake_web import bomb, photo
from PIL import ExifTags, Image

from recipes.images import NotAnImage, TooManyPixels

if TYPE_CHECKING:
    from recipes.images import ImageStore

ORIGIN = "https://plateful.test/photos/miso-soup.png"


def stored(images: ImageStore, key: str) -> tuple[dict[str, Any], Image.Image]:
    """The object at `key`, and its body decoded."""
    obj = images.client.get_object(Bucket=images.bucket, Key=key)
    return dict(obj), Image.open(io.BytesIO(obj["Body"].read()))


def keys(images: ImageStore) -> list[str]:
    listed = images.client.list_objects_v2(Bucket=images.bucket)
    return sorted(obj.get("Key", "") for obj in listed.get("Contents", []))


def test_a_photo_is_stored_as_webp_under_its_content_hash_with_a_card_size_copy(
    images: ImageStore,
) -> None:
    data = photo(1600, 1200)

    image = images.put(data, origin=ORIGIN)

    assert image.id == hashlib.sha256(data).hexdigest()[:32]
    assert (image.width, image.height, image.origin) == (1600, 1200, ORIGIN)
    assert keys(images) == [f"images/{image.id}-card.webp", f"images/{image.id}.webp"]
    for key, size in (
        (f"images/{image.id}.webp", (1600, 1200)),
        (f"images/{image.id}-card.webp", (400, 300)),
    ):
        obj, decoded = stored(images, key)
        assert obj["ContentType"] == "image/webp"
        assert obj["CacheControl"] == "public, max-age=31536000, immutable"
        assert decoded.format == "WEBP"
        assert decoded.size == size


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        pytest.param((3000, 2000), (1600, 1067), id="landscape, capped on its width"),
        pytest.param((2000, 3000), (1067, 1600), id="portrait, capped on its height"),
        pytest.param((1200, 800), (1200, 800), id="smaller than the cap, unchanged"),
    ],
)
def test_the_full_size_copy_is_capped_on_its_long_side_and_never_grown(
    images: ImageStore, source: tuple[int, int], expected: tuple[int, int]
) -> None:
    data = photo(*source)

    image = images.put(data, origin=ORIGIN)

    assert image.id == hashlib.sha256(data).hexdigest()[:32]
    assert (image.width, image.height) == expected
    _, full = stored(images, f"images/{image.id}.webp")
    assert full.size == expected
    assert abs(full.width / full.height - source[0] / source[1]) < 0.01


def test_a_photo_narrower_than_a_card_is_not_upscaled(images: ImageStore) -> None:
    image = images.put(photo(300, 500), origin=ORIGIN)

    _, card = stored(images, f"images/{image.id}-card.webp")

    assert card.size == (300, 500)


def test_the_same_photo_twice_is_stored_once_under_the_same_id(
    images: ImageStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    data = photo()
    first = images.put(data, origin=ORIGIN)
    puts: list[object] = []
    monkeypatch.setattr(images.client, "put_object", puts.append)

    second = images.put(data, origin="https://plateful.test/photos/again.png")

    assert second.id == first.id
    assert second.origin == "https://plateful.test/photos/again.png"
    assert puts == []
    assert keys(images) == [f"images/{first.id}-card.webp", f"images/{first.id}.webp"]


def test_different_photos_are_stored_under_different_ids(images: ImageStore) -> None:
    first = images.put(photo(colour="tomato"), origin=ORIGIN)
    second = images.put(photo(colour="teal"), origin=ORIGIN)

    assert first.id != second.id
    assert len(keys(images)) == 4


def test_a_photo_is_turned_upright_and_stored_without_its_metadata(images: ImageStore) -> None:
    exif = Image.Exif()
    exif[ExifTags.Base.Orientation] = 6  # shown turned 90° clockwise
    exif[ExifTags.Base.Make] = "Synthetic Camera"

    image = images.put(photo(200, 100, image_format="JPEG", exif=exif), origin=ORIGIN)

    assert (image.width, image.height) == (100, 200)
    _, full = stored(images, f"images/{image.id}.webp")
    assert full.size == (100, 200)
    assert not full.getexif()
    assert not {"exif", "xmp", "icc_profile"} & set(full.info)
    # The white top-left quarter, turned clockwise, is now the top-right.
    top_right, top_left = (
        full.convert("RGB").getpixel((75, 25)),
        full.convert("RGB").getpixel((25, 25)),
    )
    assert isinstance(top_right, tuple)
    assert isinstance(top_left, tuple)
    assert top_right[1] > 200
    assert top_left[1] < 150


def test_an_image_exists_once_it_is_stored(images: ImageStore) -> None:
    assert not images.exists("0" * 32)

    image = images.put(photo(), origin=ORIGIN)

    assert images.exists(image.id)


@pytest.mark.parametrize(
    "data",
    [
        pytest.param(b"<!doctype html><html></html>", id="a page"),
        pytest.param(b"", id="empty"),
        pytest.param(photo()[:200], id="a truncated photo"),
        pytest.param(photo(image_format="BMP"), id="a format Plateful doesn't take"),
    ],
)
def test_a_file_that_isnt_a_photo_is_refused(images: ImageStore, data: bytes) -> None:
    with pytest.raises(NotAnImage):
        images.put(data, origin=ORIGIN)

    assert keys(images) == []


def test_a_photo_that_decodes_to_too_many_pixels_is_refused(images: ImageStore) -> None:
    data = bomb()
    assert len(data) < 100 * 1024

    with pytest.raises(TooManyPixels):
        images.put(data, origin=ORIGIN)

    assert keys(images) == []
