"""The API as `make dev STAGING_PROFILE=…` runs it: on staging's table and images bucket, and
serving the bucket's images at `/images/*`, as CloudFront does on a stack. Lambda runs
`recipes.api:app`, which has no such route.
"""

from recipes.api import create_app
from recipes.dev import dev_images

app = create_app()
app.include_router(dev_images)
