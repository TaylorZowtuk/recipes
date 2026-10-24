"""The HTTP API that CloudFront routes `/api/*` to."""

from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Annotated, Any, Literal

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Path, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel

from recipes.auth import Auth
from recipes.auth import router as auth_router
from recipes.models import SCHEMA_VERSION, Card, KitchenSettings, Recipe, Ulid
from recipes.store import Store, VersionConflict

if TYPE_CHECKING:
    from collections.abc import AsyncGenerator, Awaitable, Callable

# A versioned URL never changes what it serves, so CloudFront and phones keep it for good.
IMMUTABLE = "public, max-age=31536000, immutable"
NO_STORE = {"Cache-Control": "no-store"}
REDIRECT: dict[int | str, dict[str, Any]] = {
    307: {"description": "Not the current version: redirects to it"}
}


class Sync(BaseModel):
    """What a phone polls to learn whether its cached copy is stale."""

    collection_version: int
    schema_version: int
    read_only: Literal["updating"] | None
    weeks: dict[str, int] | None


class Collection(BaseModel):
    """Everything a phone caches about the Collection, at one collection version."""

    collection_version: int
    cards: list[Card]
    kitchen_settings: KitchenSettings


def _store(request: Request) -> Store:
    return request.app.state.store


StoreDep = Annotated[Store, Depends(_store)]
router = APIRouter(prefix="/api")


@router.get("/sync")
def get_sync(store: StoreDep, response: Response) -> Sync:
    response.headers.update(NO_STORE)
    return Sync(
        collection_version=store.collection_version(),
        schema_version=SCHEMA_VERSION,
        read_only=None,
        weeks=None,
    )


@router.get("/collection", response_model=Collection, responses=REDIRECT)
def get_collection(
    store: StoreDep, response: Response, v: int | None = None
) -> Collection | Response:
    current = store.collection_version()
    if v != current:
        return RedirectResponse(f"/api/collection?v={current}", 307, headers=NO_STORE)
    # Read after the counter, so the cards are never older than the version they're cached as.
    response.headers["Cache-Control"] = IMMUTABLE
    return Collection(
        collection_version=current,
        cards=store.cards(),
        kitchen_settings=store.kitchen_settings(),
    )


@router.get(
    "/recipes/{recipe_id}",
    response_model=Recipe,
    responses={**REDIRECT, 404: {"description": "No such recipe"}},
)
def get_recipe(
    recipe_id: Annotated[Ulid, Path()],
    store: StoreDep,
    response: Response,
    v: int | None = None,
    s: int | None = None,
) -> Recipe | Response:
    """A recipe at its version (`v`) and schema version (`s`), which make up its cache key."""
    recipe = store.get_recipe(recipe_id)
    if recipe is None:
        raise HTTPException(404, "No such recipe", headers=NO_STORE)
    if (v, s) != (recipe.version, SCHEMA_VERSION):
        url = f"/api/recipes/{recipe_id}?v={recipe.version}&s={SCHEMA_VERSION}"
        return RedirectResponse(url, 307, headers=NO_STORE)
    response.headers["Cache-Control"] = IMMUTABLE
    return recipe


def version_conflict(_request: Request, _exc: Exception) -> JSONResponse:
    return JSONResponse(
        {"detail": "Version conflict: reload and try again"}, status_code=409, headers=NO_STORE
    )


async def no_store_by_default(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    """Every API response that doesn't say how to cache it is never cached, 422s included."""
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-store")
    return response


async def noindex(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    # CloudFront skips viewer-response functions when the origin answers 400 or
    # more, so the API marks its own responses. An unhandled exception never
    # comes back through here: server_error marks its 500 instead.
    response = await call_next(request)
    response.headers["X-Robots-Tag"] = "noindex"
    return response


def server_error(_request: Request, _exc: Exception) -> JSONResponse:
    # Starlette sends this 500 from its outermost middleware, outside every other, so it sets its
    # own headers: CloudFront would otherwise cache the 500 after DynamoDB has recovered.
    return JSONResponse(
        {"detail": "Internal Server Error"},
        status_code=500,
        headers={**NO_STORE, "X-Robots-Tag": "noindex"},
    )


def create_app(
    *, store: Callable[[], Store] = Store.from_env, auth: Callable[[], Auth] = Auth.from_env
) -> FastAPI:
    """The API on the table `store` opens, signing editors in with `auth`. On startup it bootstraps
    the table, or refuses to start on another schema. Sign-in reads its settings on first need.
    """

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None]:
        opened = store()
        opened.bootstrap()
        app.state.store = opened
        app.state.auth = auth()
        yield

    app = FastAPI(title="Plateful", lifespan=lifespan)
    app.include_router(router)
    app.include_router(auth_router)
    app.middleware("http")(no_store_by_default)
    app.middleware("http")(noindex)
    app.add_exception_handler(VersionConflict, version_conflict)
    app.add_exception_handler(Exception, server_error)
    return app


app = create_app()
