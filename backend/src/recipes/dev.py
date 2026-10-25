"""Routes only the dev apps serve, never Lambda's `recipes.api:app`."""

from botocore.exceptions import ClientError
from fastapi import APIRouter, HTTPException, Response

from recipes.api import ImagesDep

# `/images/*` from the images bucket, as CloudFront serves it on a stack.
dev_images = APIRouter(include_in_schema=False)


@dev_images.get("/images/{name}")
def image(name: str, images: ImagesDep) -> Response:
    try:
        stored = images.client.get_object(Bucket=images.bucket, Key=f"images/{name}")
    except ClientError:
        raise HTTPException(404, "No such image") from None
    return Response(
        stored["Body"].read(),
        media_type=stored.get("ContentType"),
        headers={"Cache-Control": stored.get("CacheControl", "no-store")},
    )
