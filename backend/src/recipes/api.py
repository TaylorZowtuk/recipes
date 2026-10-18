"""The HTTP API that CloudFront routes `/api/*` to."""

from collections.abc import Awaitable, Callable
from typing import Literal

from fastapi import FastAPI, Request, Response
from pydantic import BaseModel

SCHEMA_VERSION = 1

app = FastAPI(title="Plateful")


@app.middleware("http")
async def noindex(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    # CloudFront skips viewer-response functions when the origin answers 400 or
    # more, so the API marks its own responses, errors included.
    response = await call_next(request)
    response.headers["X-Robots-Tag"] = "noindex"
    return response


class Sync(BaseModel):
    """What a phone polls to learn whether its cached copy is stale."""

    collection_version: int
    schema_version: int
    read_only: Literal["updating"] | None
    weeks: dict[str, int] | None


@app.get("/api/sync")
def get_sync(response: Response) -> Sync:
    # Stub: the collection counter and Week Plan versions come from the table
    # once it exists.
    response.headers["Cache-Control"] = "no-store"
    return Sync(
        collection_version=0,
        schema_version=SCHEMA_VERSION,
        read_only=None,
        weeks=None,
    )
