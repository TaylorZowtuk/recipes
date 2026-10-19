"""The HTTP API that CloudFront routes `/api/*` to."""

from typing import TYPE_CHECKING, Literal

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

SCHEMA_VERSION = 1

app = FastAPI(title="Plateful")


@app.middleware("http")
async def noindex(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    # CloudFront skips viewer-response functions when the origin answers 400 or
    # more, so the API marks its own responses. An unhandled exception never
    # comes back through here: server_error marks its 500 instead.
    response = await call_next(request)
    response.headers["X-Robots-Tag"] = "noindex"
    return response


@app.exception_handler(Exception)
async def server_error(_request: Request, _exc: Exception) -> JSONResponse:
    # Starlette sends this 500 from its outermost middleware, outside noindex.
    return JSONResponse(
        {"detail": "Internal Server Error"},
        status_code=500,
        headers={"X-Robots-Tag": "noindex"},
    )


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
