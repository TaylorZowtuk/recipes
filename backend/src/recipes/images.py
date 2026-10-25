"""Recipe photos in the stack's images bucket, which CloudFront serves at `/images/*`.

Each photo is stored once, as WebP under its content hash, with a card-size copy next to it for
the grid and the offline prefetch. A hashed key never changes what it serves.
"""

import hashlib
import io
import os
from typing import TYPE_CHECKING

import boto3
from botocore.exceptions import ClientError
from PIL import Image as Pillow
from PIL import ImageOps

from recipes.models import Image

if TYPE_CHECKING:
    from types_boto3_s3 import S3Client

# A versioned URL never changes what it serves, so CloudFront and phones keep it for good.
IMMUTABLE = "public, max-age=31536000, immutable"
CARD_WIDTH = 400
# Decoding is refused past this many pixels, so a small file can't fill the API's 512 MB.
MAX_PIXELS = 24_000_000
# The formats websites serve photos in. Pillow's other decoders are never tried.
FORMATS = ("JPEG", "PNG", "WEBP", "GIF")
QUALITY = 80


class NotAnImage(ValueError):
    """Not a photo in one of FORMATS that decodes."""


class TooManyPixels(ValueError):
    """A photo that would decode to more than MAX_PIXELS."""


def image_id(data: bytes) -> str:
    """A photo's content hash: the first 128 bits of the SHA-256 of its bytes as fetched."""
    return hashlib.sha256(data).hexdigest()[:32]


def image_key(image_id: str) -> str:
    return f"images/{image_id}.webp"


def card_image_key(image_id: str) -> str:
    return f"images/{image_id}-card.webp"


class ImageStore:
    def __init__(self, bucket: str, client: S3Client | None = None) -> None:
        self.bucket = bucket
        self.client: S3Client = client or boto3.client("s3")

    @classmethod
    def from_env(cls) -> ImageStore:
        return cls(os.environ["IMAGES_BUCKET"])

    def put(self, data: bytes, origin: str) -> Image:
        """Store the photo in `data`, upright and without its metadata, unless it's already
        stored. Raises NotAnImage or TooManyPixels.
        """
        full, card, (width, height) = _encode(data)
        stored = Image(id=image_id(data), width=width, height=height, origin=origin)
        if not self.exists(stored.id):
            # The card first, so a stored full-size image always has its card.
            self._put(card_image_key(stored.id), card)
            self._put(image_key(stored.id), full)
        return stored

    def exists(self, image_id: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=image_key(image_id))
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") in {"404", "NoSuchKey"}:
                return False
            raise
        return True

    def _put(self, key: str, body: bytes) -> None:
        self.client.put_object(
            Bucket=self.bucket,
            Key=key,
            Body=body,
            ContentType="image/webp",
            CacheControl=IMMUTABLE,
        )


def _encode(data: bytes) -> tuple[bytes, bytes, tuple[int, int]]:
    """The photo and its card-size copy as WebP, and the photo's upright size. Saving writes
    none of the source's EXIF, XMP or colour profile.
    """
    try:
        image = Pillow.open(io.BytesIO(data), formats=FORMATS)
    except Pillow.DecompressionBombError:
        raise TooManyPixels from None
    # Pillow fails in many ways on a file that isn't a photo it can decode.
    except Exception:
        raise NotAnImage from None
    with image:
        if image.width * image.height > MAX_PIXELS:
            raise TooManyPixels
        try:
            ImageOps.exif_transpose(image, in_place=True)
            size, full = image.size, _webp(image)
            # Shrinks to the card's width, never growing a narrower photo.
            image.thumbnail((CARD_WIDTH, image.height))
            return full, _webp(image), size
        except Exception:
            raise NotAnImage from None


def _webp(image: Pillow.Image) -> bytes:
    out = io.BytesIO()
    image.save(out, "WEBP", quality=QUALITY)
    return out.getvalue()
