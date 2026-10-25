"""The API as `make dev STAGING_PROFILE=…` runs it: on staging's table and images bucket, and
serving the bucket's images at `/images/*`, as CloudFront does on a stack. Lambda runs
`recipes.api:app`, which has no such route.
"""

from typing import TYPE_CHECKING

from botocore.exceptions import ClientError
from fastapi import FastAPI, HTTPException, Request, Response

from recipes.api import create_app

if TYPE_CHECKING:
    from recipes.images import ImageStore


def serve_images(app: FastAPI) -> FastAPI:
    """Adds `/images/{name}`, served from the images bucket the app opened."""

    @app.get("/images/{name}", include_in_schema=False)
    def _image(name: str, request: Request) -> Response:
        images: ImageStore = request.app.state.images
        try:
            stored = images.client.get_object(Bucket=images.bucket, Key=f"images/{name}")
        except ClientError:
            raise HTTPException(404, "No such image") from None
        return Response(
            stored["Body"].read(),
            media_type=stored.get("ContentType"),
            headers={"Cache-Control": stored.get("CacheControl", "no-store")},
        )

    return app


app = serve_images(create_app())
