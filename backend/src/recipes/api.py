"""The HTTP API that CloudFront routes `/api/*` to."""

import re
from collections import Counter
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Annotated, Any, Literal, cast

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Path, Query, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import (
    BaseModel,
    BeforeValidator,
    Field,
    StringConstraints,
    TypeAdapter,
    ValidationError,
    model_validator,
)

from recipes.auth import Auth, CurrentEditor, require_editor
from recipes.auth import router as auth_router
from recipes.edits import CONFIRMED_BY, FactEdit, confirm_matches, edit_recipe, overused, share_all
from recipes.images import IMMUTABLE, ImageStore, NotAnImage, TooManyPixels
from recipes.ingest import (
    LLM_EXTRACTOR,
    MAX_PAGE_BYTES,
    PASTED_EXTRACTOR,
    Fetcher,
    FetchRefused,
    IngestFailed,
    InvalidUrl,
    PageNotFound,
    PoliteFetcher,
    TooLarge,
    parse,
    website_dedupe_key,
)
from recipes.models import (
    MAX_FAVORITE_SITES,
    MAX_LABEL,
    MAX_LINES,
    MAX_RECIPE_BYTES,
    MAX_SITE_NOTE,
    PORTION_TOLERANCE,
    SCHEMA_VERSION,
    CanonicalIngredient,
    Card,
    Difficulty,
    DurationSegment,
    Enrichment,
    EnrichmentStatus,
    EntryAmount,
    Fact,
    FavoriteSite,
    FavoriteSites,
    Image,
    IngredientFacts,
    IngredientSegment,
    KitchenSettings,
    Label,
    MatchFact,
    Model,
    Monday,
    Original,
    Preview,
    QueuedIngest,
    QueuedIngestReason,
    QueuedIngestState,
    Recipe,
    RecipeFacts,
    ScaleAmount,
    StepFacts,
    StoreCategory,
    Substitution,
    TemperatureSegment,
    Ulid,
    WebsiteSource,
    WebUrl,
    WeekPlan,
    WeekPlanEntry,
    Wording,
    fact_at,
    fact_paths,
    new_ulid,
    normalize_wording,
    resolve,
    settled,
    site_host,
    written_as,
)
from recipes.offers import find_offers
from recipes.store import (
    MAX_LEARNED,
    CanonicalExists,
    DuplicateSource,
    Store,
    VersionConflict,
    WordingConfirmed,
)

if TYPE_CHECKING:
    from collections.abc import AsyncGenerator, Awaitable, Callable

NO_STORE = {"Cache-Control": "no-store"}
REDIRECT: dict[int | str, dict[str, Any]] = {
    307: {"description": "Not the current version: redirects to it"}
}
TO_CURRENT: dict[int | str, dict[str, Any]] = {
    307: {"description": "Redirects to the current version"}
}
# A recipe's photos: more than the review offers, for photos added later.
MAX_IMAGES = 20


def _canonical(segment: str) -> str:
    if not re.fullmatch(r"0|[1-9][0-9]*", segment):
        msg = "A version is written in digits, with no leading zero"
        raise ValueError(msg)
    return segment


# A version in a cache key, accepted only as digits with no leading zero: 02, +2 or 2.0 would
# each be a year-long CloudFront cache key of its own. ONE_SPELLING refuses %31 for 1.
Version = Annotated[int, BeforeValidator(_canonical), Path()]


def _not_percent_encoded(request: Request) -> None:
    if b"%" in request.scope["raw_path"]:
        msg = "A versioned read is not percent-encoded"
        raise RequestValidationError([{"type": "percent_encoded", "loc": ("path",), "msg": msg}])


# Starlette decodes a path before routing, so a percent-encoded character anywhere in a
# versioned read would be another year-long cache key. The PWA and enrich never send one.
ONE_SPELLING = [Depends(_not_percent_encoded)]


class Sync(BaseModel):
    """What a phone polls to learn whether its cached copy is stale."""

    collection_version: int
    schema_version: int
    read_only: Literal["updating"] | None
    weeks: dict[str, int] | None


class CountedSite(FavoriteSite):
    recipe_count: int  # the cards on its host, derived when read and never stored


class CountedSites(Model):
    """The Favorite Sites as phones see them, at the `version` an Edit of them sends back."""

    version: int
    sites: list[CountedSite]  # in the order the Sites tab shows them


class Collection(BaseModel):
    """Everything a phone caches about the Collection, at one collection version."""

    collection_version: int
    cards: list[Card]
    canonical_ingredients: list[CanonicalIngredient]
    wordings: list[Wording]  # the Wording Cache
    kitchen_settings: KitchenSettings
    favorite_sites: CountedSites


class IngestUrl(BaseModel):
    url: WebUrl


class Ingested(BaseModel):
    """What ingesting a website captured, for an editor to review before saving. Nothing is
    stored yet: saving sends it back.
    """

    source: WebsiteSource
    original: Original
    candidate_photos: list[WebUrl]  # the page's photos, each to store with POST /api/images


class PhotoUrl(BaseModel):
    url: WebUrl


class NeedsPage(BaseModel):
    reason: QueuedIngestReason


class FailedAttempt(BaseModel):
    reason: Literal["rate_limited", "server_error", "unreachable"]  # only those that may pass


class PastedPage(BaseModel):
    html: str  # at most MAX_PAGE_BYTES as UTF-8; read once, and never stored, logged or echoed


# A recipe's Tags, before `_tags` strips them, drops empty ones and spells each once.
Tags = Annotated[list[Annotated[str, StringConstraints(max_length=100)]], Field(max_length=50)]


class NewRecipe(BaseModel):
    """A recipe to add from a website: what ingest captured, plus the editor's own fields. Each
    of its images was stored by POST /api/images, and its preview shows one of them.
    """

    source: WebsiteSource
    original: Original
    difficulty: Difficulty | None = None
    tags: Tags = []
    # A factory, not a default, so the schema leaves it optional for clients that send none.
    images: Annotated[list[Image], Field(max_length=MAX_IMAGES, default_factory=list)]
    preview: Preview | None = None

    @model_validator(mode="after")
    def _previews_one_of_its_images(self) -> NewRecipe:
        ids = [image.id for image in self.images]
        if len(set(ids)) < len(ids):
            msg = "Each image is in a recipe once"
            raise ValueError(msg)
        if self.preview and self.preview.image_id not in ids:
            msg = "The preview shows one of the recipe's images"
            raise ValueError(msg)
        return self


class SetTags(BaseModel):
    op: Literal["set_tags"]
    tags: Tags


class SetDifficulty(BaseModel):
    op: Literal["set_difficulty"]
    difficulty: Difficulty | None


class SetPreview(BaseModel):
    """Show one of the recipe's images as its Preview Photo, or none with null."""

    op: Literal["set_preview"]
    preview: Preview | None


Operation = Annotated[SetTags | SetDifficulty | SetPreview, Field(discriminator="op")]


# A version DynamoDB can compare: it rejects numbers of more than 38 digits.
RecipeVersion = Annotated[int, Field(ge=1, le=2**53)]


class RecipeEdit(BaseModel):
    """An editor's batch of changes to the recipe at `version`, applied in one write."""

    version: RecipeVersion
    operations: Annotated[list[Operation], Field(min_length=1)]

    @model_validator(mode="after")
    def _each_op_once(self) -> RecipeEdit:
        ops = [operation.op for operation in self.operations]
        if len(set(ops)) < len(ops):
            msg = "Each operation is in an edit once"
            raise ValueError(msg)
        return self


class PlaceEntry(BaseModel):
    """Add a recipe to the end of a day, 0 for Monday to 6 for Sunday."""

    op: Literal["place"]
    day: Annotated[int, Field(ge=0, le=6)]
    recipe_id: Ulid
    # A factory, not a default, so the schema leaves it optional for clients that send none.
    amount: Annotated[
        EntryAmount, Field(default_factory=lambda: ScaleAmount(kind="scale", factor=1))
    ]


class RemoveEntry(BaseModel):
    op: Literal["remove"]
    entry_id: Ulid


class SetAmount(BaseModel):
    op: Literal["set_amount"]
    entry_id: Ulid
    amount: EntryAmount


WeekOperation = Annotated[PlaceEntry | RemoveEntry | SetAmount, Field(discriminator="op")]
MAX_WEEK_OPERATIONS = 100


class WeekPlanEdit(BaseModel):
    """An editor's batch of changes to the week at `version`, applied in order in one write.
    Version 0 is a week with no plan yet, which only a placement creates.
    """

    version: Annotated[int, Field(ge=0, le=2**53)]
    operations: Annotated[list[WeekOperation], Field(min_length=1, max_length=MAX_WEEK_OPERATIONS)]


# Every fact path a recipe can hold: four per line, two per step and its Difficulty.
MAX_FACT_IDS = 6 * MAX_LINES + 1


class ConfirmFacts(BaseModel):
    """An editor confirming facts of the recipe at `version` as one Confirm Batch, by path. Each
    open Enrichment Issue on a listed path is resolved with them, which accepts its correction.
    """

    version: RecipeVersion
    fact_ids: Annotated[list[Label], Field(min_length=1, max_length=MAX_FACT_IDS)]


class ConfirmedBatch(BaseModel):
    """The recipe after a confirm, the Confirm Batch that undoes it, and whether the batch moved
    the recipe from Awaiting Review to Ready.
    """

    recipe: Recipe
    confirm_batch: Ulid
    ready: bool


class EditFact(BaseModel):
    """An editor's edit of one Review Item's facts on the recipe at `version`."""

    version: RecipeVersion
    edit: FactEdit


class EditedFact(BaseModel):
    """The recipe after an edit, whether the edit moved it from Awaiting Review to Ready, the
    other recipes a line's new Canonical Ingredient was matched in by its wording, and those it
    couldn't be, because they kept changing or would be too big. Saving the line again retries
    them.
    """

    recipe: Recipe
    ready: bool
    also_updated: list[Ulid]
    not_updated: list[Ulid]


SiteName = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_LABEL)
]
SiteNote = Annotated[str, StringConstraints(strip_whitespace=True, max_length=MAX_SITE_NOTE)]


class RenameSite(BaseModel):
    op: Literal["rename"]
    id: Ulid
    name: SiteName


class SetSiteAddress(BaseModel):
    op: Literal["set_address"]
    id: Ulid
    address: WebUrl


class SetSiteNote(BaseModel):
    op: Literal["set_note"]
    id: Ulid
    note: SiteNote


class ReorderSites(BaseModel):
    """Put the sites in this order, naming each site present at that point in the batch once."""

    op: Literal["reorder"]
    ids: list[Ulid]


class DeleteSite(BaseModel):
    op: Literal["delete"]
    id: Ulid


class AddSite(BaseModel):
    """Add a site at the end of the list. The API mints its id."""

    op: Literal["add"]
    name: SiteName
    address: WebUrl
    note: SiteNote = ""


SiteOperation = Annotated[
    RenameSite | SetSiteAddress | SetSiteNote | ReorderSites | DeleteSite | AddSite,
    Field(discriminator="op"),
]


class FavoriteSitesEdit(BaseModel):
    """An editor's batch of changes to the Favorite Sites at `version`, applied in the order sent,
    in one write. The list only has to hold together once they are all applied.
    """

    version: RecipeVersion
    operations: Annotated[list[SiteOperation], Field(min_length=1)]


# Not a Ulid: the Store Categories a stack starts with have ids such as "produce".
StoreCategoryId = Annotated[str, StringConstraints(min_length=1, max_length=MAX_LABEL)]
StoreCategoryName = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_LABEL)
]


class AddStoreCategory(BaseModel):
    """Add a Store Category at the end of the list. The API mints its id."""

    op: Literal["add"]
    name: StoreCategoryName


class RenameStoreCategory(BaseModel):
    op: Literal["rename"]
    id: StoreCategoryId
    name: StoreCategoryName


class ReorderStoreCategories(BaseModel):
    """Put the categories in this order, naming each one present at that point in the batch once."""

    op: Literal["reorder"]
    ids: list[StoreCategoryId]


class DeleteStoreCategory(BaseModel):
    """Delete a Store Category, moving its Canonical Ingredients to another saved one, still there
    at that point in the batch. A category added in the batch has no id a client can name yet.
    """

    op: Literal["delete"]
    id: StoreCategoryId
    move_to: StoreCategoryId


StoreCategoryOperation = Annotated[
    AddStoreCategory | RenameStoreCategory | ReorderStoreCategories | DeleteStoreCategory,
    Field(discriminator="op"),
]


class KitchenSettingsEdit(BaseModel):
    """An editor's batch of changes to the Store Categories at `version`, applied in the order
    sent. The names only have to differ once they are all applied.
    """

    version: RecipeVersion
    operations: Annotated[list[StoreCategoryOperation], Field(min_length=1)]


class SetPantryStaple(BaseModel):
    op: Literal["set_pantry_staple"]
    pantry_staple: bool


class SetStoreCategory(BaseModel):
    op: Literal["set_store_category"]
    store_category_id: StoreCategoryId


CanonicalIngredientOperation = Annotated[
    SetPantryStaple | SetStoreCategory, Field(discriminator="op")
]


class CanonicalIngredientEdit(BaseModel):
    """Changes to one Canonical Ingredient at `version`, applied in the order sent, in one write."""

    version: RecipeVersion
    operations: Annotated[list[CanonicalIngredientOperation], Field(min_length=1)]


class Duplicate(BaseModel):
    """A 409: the Source is already a recipe in the Collection, or already a Queued Ingest. With
    neither id, its guard was there a moment ago and isn't now, so the editor can try again.
    """

    detail: str
    recipe_id: Ulid | None
    queued_ingest_id: Ulid | None


def _store(request: Request) -> Store:
    return request.app.state.store


def _fetcher(request: Request) -> Fetcher:
    return request.app.state.fetcher


def _images(request: Request) -> ImageStore:
    return request.app.state.images


StoreDep = Annotated[Store, Depends(_store)]
FetcherDep = Annotated[Fetcher, Depends(_fetcher)]
ImagesDep = Annotated[ImageStore, Depends(_images)]
EDITORS_ONLY = [Depends(require_editor)]
router = APIRouter(prefix="/api")


# More than the phones watch, which is the current and next weeks.
MAX_WATCHED_WEEKS = 8
WATCHED_WEEKS: TypeAdapter[list[str]] = TypeAdapter(
    Annotated[list[Monday], Field(max_length=MAX_WATCHED_WEEKS)]
)


@router.get(
    "/sync",
    responses={422: {"description": f"An editor named a non-Monday or over {MAX_WATCHED_WEEKS}"}},
)
def get_sync(
    store: StoreDep,
    editor: CurrentEditor,
    response: Response,
    weeks: Annotated[list[str], Query(default_factory=list)],
) -> Sync:
    """What a phone polls. `weeks` are the Mondays an editor watches, and only an editor's are
    read or checked, so a visitor's answer is the same whatever it asks.
    """
    response.headers.update(NO_STORE)
    return Sync(
        collection_version=store.collection_version(),
        schema_version=SCHEMA_VERSION,
        read_only=None,
        weeks=None if editor is None else store.week_versions(_watched(weeks)),
    )


def _watched(weeks: list[str]) -> list[str]:
    try:
        return WATCHED_WEEKS.validate_python(weeks)
    except ValidationError:
        msg = f"Watch at most {MAX_WATCHED_WEEKS} weeks, each named by its Monday"
        raise HTTPException(422, msg) from None


@router.get("/collection", status_code=307, response_class=RedirectResponse, responses=TO_CURRENT)
def get_current_collection(store: StoreDep) -> RedirectResponse:
    """Redirects to the Collection at its current version."""
    return _redirect(_collection_path(store.collection_version()))


# Everything under /api/v/ is cached by CloudFront for whoever asks, so no route there may
# check for an editor: that answer depends on the cookie.
@router.get(
    "/v/collection/{collection_version}",
    response_model=Collection,
    dependencies=ONE_SPELLING,
    responses=REDIRECT,
)
def get_collection(
    collection_version: Version, store: StoreDep, response: Response
) -> Collection | Response:
    current = store.collection_version()
    if collection_version != current:
        return _redirect(_collection_path(current))
    # Read after the counter, so the cards are never older than the version they're cached as.
    response.headers["Cache-Control"] = IMMUTABLE
    cards = store.cards()
    return Collection(
        collection_version=current,
        cards=cards,
        canonical_ingredients=store.canonical_ingredients(),
        wordings=store.wordings(),
        kitchen_settings=store.kitchen_settings(),
        favorite_sites=_counted_sites(store.favorite_sites(), cards),
    )


NO_SUCH_RECIPE: dict[int | str, dict[str, Any]] = {404: {"description": "No such recipe"}}


@router.get(
    "/recipes/{recipe_id}",
    status_code=307,
    response_class=RedirectResponse,
    responses={**TO_CURRENT, **NO_SUCH_RECIPE},
)
def get_current_recipe(recipe_id: Annotated[Ulid, Path()], store: StoreDep) -> RedirectResponse:
    """Redirects to the recipe at its current version and schema version."""
    return _redirect(_recipe_path(_recipe(store, recipe_id)))


@router.get(
    "/v/recipes/{recipe_id}/{recipe_version}/{schema_version}",
    response_model=Recipe,
    dependencies=ONE_SPELLING,
    responses={**REDIRECT, **NO_SUCH_RECIPE},
)
def get_recipe(
    recipe_id: Annotated[Ulid, Path()],
    recipe_version: Version,
    schema_version: Version,
    store: StoreDep,
    response: Response,
) -> Recipe | Response:
    """A recipe at its version and schema version, which make up its cache key."""
    recipe = _recipe(store, recipe_id)
    if (recipe_version, schema_version) != (recipe.version, SCHEMA_VERSION):
        return _redirect(_recipe_path(recipe))
    response.headers["Cache-Control"] = IMMUTABLE
    return recipe


def _recipe(store: Store, recipe_id: str) -> Recipe:
    recipe = store.get_recipe(recipe_id)
    if recipe is None:
        raise HTTPException(404, "No such recipe", headers=NO_STORE)
    return recipe


def _collection_path(version: int) -> str:
    return f"/api/v/collection/{version}"


def _recipe_path(recipe: Recipe) -> str:
    return f"/api/v/recipes/{recipe.id}/{recipe.version}/{SCHEMA_VERSION}"


def _redirect(path: str) -> RedirectResponse:
    return RedirectResponse(path, 307, headers=NO_STORE)


INVALID_URL = {422: {"description": "Not an http(s) URL with a host"}}
DUPLICATE: dict[int | str, dict[str, Any]] = {
    409: {"model": Duplicate, "description": "The Source is already a recipe or a Queued Ingest"},
    403: {"description": "Only an editor can do that"},
}


@router.post(
    "/ingest",
    response_model=Ingested,
    dependencies=EDITORS_ONLY,
    responses={
        **DUPLICATE,
        **INVALID_URL,
        202: {"model": QueuedIngest, "description": "Couldn't be captured, so it was queued"},
        404: {"description": "The website says the page isn't there"},
    },
)
def post_ingest(body: IngestUrl, store: StoreDep, fetcher: FetcherDep) -> Ingested | Response:
    """Capture a website's recipe for review, storing nothing, unless its Source is already
    claimed. A page that can't be captured becomes a Queued Ingest that reserves the Source.
    """
    key = _dedupe_key(body.url)
    # Before any fetch, robots.txt included, so a known Source never reaches the site.
    if duplicate := _duplicate(store, key):
        return duplicate
    now = datetime.now(UTC)
    try:
        # Scraped as the site the page came from, while the pasted URL stays the Source.
        page = fetcher(body.url)
        captured = parse(page.html, page.url)
    except PageNotFound:
        raise HTTPException(404, "That page isn't on the website") from None
    except IngestFailed as failed:
        queued = QueuedIngest(
            schema_version=SCHEMA_VERSION,
            id=new_ulid(),
            source=WebsiteSource(url=body.url, site_name=site_host(key), captured_at=now),
            dedupe_key=key,
            state=_queued_state(failed),
            reason=failed.reason,
            queued_at=now,
        )
        try:
            store.queue_ingest(queued)
        except DuplicateSource:
            return _claimed(store, key)
        return JSONResponse(queued.model_dump(mode="json"), status_code=202)
    source = WebsiteSource(
        url=body.url, site_name=captured.site_name or site_host(key), captured_at=now
    )
    return Ingested(
        source=source, original=captured.original, candidate_photos=captured.candidate_photos
    )


@router.post(
    "/images",
    dependencies=EDITORS_ONLY,
    responses={
        403: DUPLICATE[403],
        404: {"description": "The website says the photo isn't there"},
        422: {"description": "Not an http(s) URL, or not a photo Plateful can store"},
        502: {"description": "The photo couldn't be fetched, or robots.txt refuses it"},
    },
)
def post_image(body: PhotoUrl, fetcher: FetcherDep, images: ImagesDep) -> Image:
    """Store one of the candidate photos ingest found, fetched as politely as the page. Any
    error means that candidate is unavailable.
    """
    try:
        return images.put(fetcher.photo(body.url), origin=body.url)
    except PageNotFound:
        raise HTTPException(404, "That photo isn't on the website") from None
    except TooLarge, TooManyPixels:
        raise HTTPException(422, "That photo is too large") from None
    except NotAnImage:
        raise HTTPException(422, "That isn't a photo") from None
    except IngestFailed as failed:
        raise HTTPException(502, f"That photo couldn't be fetched ({failed.reason})") from None


@router.post(
    "/recipes",
    response_model=Recipe,
    status_code=201,
    dependencies=EDITORS_ONLY,
    responses={**DUPLICATE, 422: {"description": "Not a valid recipe, or an image isn't stored"}},
)
def post_recipe(body: NewRecipe, store: StoreDep, images: ImagesDep) -> Recipe | Response:
    """Add the recipe an editor reviewed, Pending enrichment, with its card and Source guard."""
    key = _dedupe_key(body.source.url)
    recipe = _new_recipe(body, key, store, images)
    try:
        return store.add_recipe(recipe)
    except DuplicateSource:
        return _claimed(store, key)


def _new_recipe(body: NewRecipe, key: str, store: Store, images: ImageStore) -> Recipe:
    """The recipe `body` describes, Pending enrichment, once each of its images is stored."""
    if not all(images.exists(image.id) for image in body.images):
        raise HTTPException(422, "Store each image with POST /api/images first")
    return Recipe(
        id=new_ulid(),
        schema_version=SCHEMA_VERSION,
        version=1,
        source=body.source,
        dedupe_key=key,
        original=body.original,
        tags=_tags(body.tags, store),
        difficulty=body.difficulty,
        images=body.images,
        preview=body.preview,
        status="pending",
        ingest_channel="add_a_recipe",
    )


@router.put(
    "/recipes/{recipe_id}/enrichment",
    response_model=Recipe,
    dependencies=EDITORS_ONLY,
    responses={
        403: DUPLICATE[403],
        404: {"description": "No such recipe"},
        409: {
            "description": "The recipe isn't Pending or changed meanwhile, a new Canonical "
            "Ingredient's id is taken, or an editor confirmed a wording"
        },
        422: {
            "description": "A fact or Enrichment Issue is for a line or step the recipe doesn't "
            "have, a step's segments aren't its text, its segments or uses name a line the recipe "
            "doesn't have, a line's portions add up to more than 1, an issue isn't open, "
            "substitutions or a suggested Difficulty aren't the LLM's unconfirmed estimate, a "
            "substitute is its line's own match, a wording isn't a parsed line's name, it learns "
            "more than one write holds, a fact names an unknown Canonical Ingredient or Store "
            "Category, or a new Canonical Ingredient or wording is confirmed or at another schema "
            "version, or the enriched recipe is too big to store"
        },
    },
)
def put_enrichment(recipe_id: Annotated[Ulid, Path()], body: Enrichment, store: StoreDep) -> Recipe:
    """Store a Pending recipe's facts and Enrichment Issues, with the Canonical Ingredients they
    create and the wordings they learn. A bulk import's recipe is then Ready, and any other, or
    any whose Original an LLM extracted, waits in Awaiting Review for an editor to check it.

    Refused unless every fact is for one of the recipe's lines or steps, every step's segments
    are its text exactly and name only its lines, as do its uses, no step uses a line twice, every
    duration or temperature segment is one code finds in its step's text, a step with segments has
    uses that are exactly its segments' Step Portions summed per line, each line's `portion`s across
    the steps add up to at most 1, every Enrichment Issue is on one of their facts and arrives open
    with no Confirm Batch, substitutions and a suggested Difficulty arrive from the LLM, estimated
    and unconfirmed, no substitute is its line's own match, every wording is the normalized name of
    one of the parsed lines, it learns at most MAX_LEARNED items, every match, substitute and
    wording names a Canonical Ingredient that exists or is new here, every new one's Store Category
    exists, every new Canonical Ingredient and wording is unconfirmed and at SCHEMA_VERSION, and
    the enriched recipe is at most MAX_RECIPE_BYTES as JSON.
    """
    recipe = store.get_recipe(recipe_id)
    if recipe is None:
        raise HTTPException(404, "No such recipe")
    if recipe.status != "pending":
        raise HTTPException(409, "Only a Pending recipe can be enriched")
    _check_lines(body, recipe)
    _check_steps(body, recipe)
    _check_suggestions(body)
    if len(body.canonical_ingredients) + len(body.wordings) > MAX_LEARNED:
        raise HTTPException(
            422, f"An enrichment learns at most {MAX_LEARNED} Canonical Ingredients and wordings"
        )
    _check_canonical_ingredients(body, store)
    enriched = recipe.model_copy(
        update={
            "facts": body.facts,
            "enrichment_version": body.enrichment_version,
            "fdc_release": body.fdc_release,
            "issues": body.issues,
            "status": _enriched_status(recipe),
        }
    )
    if len(enriched.model_dump_json().encode()) > MAX_RECIPE_BYTES:
        raise HTTPException(422, f"An enriched recipe is at most {MAX_RECIPE_BYTES} bytes as JSON")
    try:
        return store.enrich_recipe(enriched, body.canonical_ingredients, body.wordings)
    except CanonicalExists:
        raise HTTPException(409, "A new Canonical Ingredient's id is taken") from None
    except WordingConfirmed:
        raise HTTPException(409, "An editor confirmed one of the wordings") from None


def _enriched_status(recipe: Recipe) -> EnrichmentStatus:
    skips_review = (
        recipe.ingest_channel == "bulk_import" and recipe.original.extractor != LLM_EXTRACTOR
    )
    return "ready" if skips_review else "awaiting_review"


@router.patch(
    "/recipes/{recipe_id}",
    response_model=Recipe,
    dependencies=EDITORS_ONLY,
    responses={
        403: DUPLICATE[403],
        **NO_SUCH_RECIPE,
        409: {"description": "The recipe changed since the editor read it"},
        422: {"description": "Not a valid edit, or the preview isn't one of the recipe's images"},
    },
)
def patch_recipe(recipe_id: Annotated[Ulid, Path()], body: RecipeEdit, store: StoreDep) -> Recipe:
    """Apply an editor's Tags, Difficulty and Preview Photo changes to the recipe at
    `body.version`, with its card, in one write. A recipe Awaiting Review with nothing left to
    review is Ready.
    """
    recipe = _recipe(store, recipe_id)
    changes: dict[str, object] = {"version": body.version}
    for operation in body.operations:
        match operation:
            case SetTags():
                changes["tags"] = _tags(operation.tags, store, editing=recipe.id)
            case SetDifficulty():
                changes["difficulty"] = operation.difficulty
            case SetPreview():
                preview = operation.preview
                if preview and preview.image_id not in {image.id for image in recipe.images}:
                    raise HTTPException(422, "The preview shows one of the recipe's images")
                changes["preview"] = preview
    # The editor's own Difficulty drops the suggestion from review, which can leave nothing to
    # review: the recipe is then Ready, though no Confirm Batch made it so.
    return store.update_recipe(settled(recipe.model_copy(update=changes)))


@router.delete(
    "/recipes/{recipe_id}",
    status_code=204,
    response_class=Response,
    dependencies=EDITORS_ONLY,
    responses={
        403: DUPLICATE[403],
        **NO_SUCH_RECIPE,
        409: {"description": "The recipe changed since the editor read it"},
    },
)
def delete_recipe(
    recipe_id: Annotated[Ulid, Path()], version: Annotated[RecipeVersion, Query()], store: StoreDep
) -> Response:
    """Delete the recipe at `version`, with its card and Source guard, so its Source can be
    added again.
    """
    recipe = _recipe(store, recipe_id)
    store.delete_recipe(recipe.model_copy(update={"version": version}))
    return Response(status_code=204)


NOT_A_MONDAY: dict[int | str, dict[str, Any]] = {422: {"description": "Not a real Monday"}}


@router.get(
    "/weeks/{monday}",
    dependencies=EDITORS_ONLY,
    responses={403: DUPLICATE[403], **NOT_A_MONDAY},
)
def get_week_plan(monday: Annotated[Monday, Path()], store: StoreDep) -> WeekPlan:
    """The week's plan, or an empty one at version 0 if nothing has been placed in it."""
    return store.week_plan(monday)


@router.patch(
    "/weeks/{monday}",
    dependencies=EDITORS_ONLY,
    responses={
        403: DUPLICATE[403],
        404: {"description": "No such recipe to place, or no such entry"},
        409: {"description": "The Week Plan changed since the editor read it"},
        422: {"description": "Not a real Monday, or not a valid edit"},
    },
)
def patch_week_plan(
    monday: Annotated[Monday, Path()], body: WeekPlanEdit, store: StoreDep
) -> WeekPlan:
    """Apply an editor's placements, removals and new amounts to the week at `body.version`, in
    one write. The first placement creates the plan, and removing every entry keeps it.
    """
    plan = store.week_plan(monday)
    if plan.version != body.version:
        raise VersionConflict(monday)
    days = [list(day) for day in plan.days]
    for operation in body.operations:
        match operation:
            case PlaceEntry():
                recipe = _recipe(store, operation.recipe_id)
                entry = WeekPlanEntry(
                    entry_id=new_ulid(),
                    recipe_id=recipe.id,
                    recipe_title=recipe.original.title,
                    amount=operation.amount,
                )
                days[operation.day].append(entry)
            case RemoveEntry():
                day, index = _entry_at(days, operation.entry_id)
                del day[index]
            case SetAmount():
                day, index = _entry_at(days, operation.entry_id)
                day[index] = day[index].model_copy(update={"amount": operation.amount})
    return store.save_week_plan(plan.model_copy(update={"days": days}))


def _entry_at(days: list[list[WeekPlanEntry]], entry_id: str) -> tuple[list[WeekPlanEntry], int]:
    """The day holding the entry, and where in that day it is."""
    for day in days:
        for index, entry in enumerate(day):
            if entry.entry_id == entry_id:
                return day, index
    raise HTTPException(404, "No such entry")


@router.post(
    "/recipes/{recipe_id}/confirm",
    dependencies=EDITORS_ONLY,
    responses={
        403: DUPLICATE[403],
        **NO_SUCH_RECIPE,
        409: {
            "description": "The recipe, or a Canonical Ingredient or wording it confirms, changed"
        },
        422: {
            "description": "A path is neither one of the recipe's facts nor named by an open "
            "Enrichment Issue, every listed fact is already Confirmed with no open issue, or it "
            "confirms more Canonical Ingredients and wordings than one write holds"
        },
    },
)
def confirm_facts(
    recipe_id: Annotated[Ulid, Path()], body: ConfirmFacts, store: StoreDep
) -> ConfirmedBatch:
    """Confirm the listed facts of the recipe at `body.version` as one new Confirm Batch, and
    resolve the open Enrichment Issues on them. A fact already Confirmed keeps its own batch.

    Confirming a match also confirms its Canonical Ingredient, stamped with the batch, and the
    wording of its line's name. A recipe Awaiting Review with nothing left to review is Ready.
    """
    recipe = _recipe(store, recipe_id)
    if recipe.version != body.version:
        raise VersionConflict(recipe.id)
    facts = recipe.facts.model_copy(deep=True)
    listed = set(body.fact_ids)
    open_on = {issue.fact_id for issue in recipe.issues if issue.status == "open"}
    if unknown := sorted(p for p in listed - open_on if fact_at(facts, p) is None):
        raise HTTPException(422, f"The recipe has no fact {', '.join(unknown)}")
    batch, now = new_ulid(), datetime.now(UTC)
    confirming = sorted(p for p in listed if (f := fact_at(facts, p)) and not f.confirmed)
    if not confirming and not listed & open_on:
        raise HTTPException(422, "Every listed fact is already Confirmed")
    for path in confirming:
        fact = cast("Fact", fact_at(facts, path))
        fact.confirmed, fact.confirmed_by, fact.confirmed_at = True, CONFIRMED_BY, now
        fact.confirm_batch = batch
    issues = resolve(recipe, lambda fact_id: fact_id in listed, batch)
    canonicals, wordings = confirm_matches(store, facts, confirming, batch)
    if len(canonicals) + len(wordings) > MAX_LEARNED:
        raise HTTPException(422, "Confirm fewer matches at once")
    reviewed = settled(recipe.model_copy(update={"facts": facts, "issues": issues}), batch)
    ready = recipe.status == "awaiting_review" and reviewed.status == "ready"
    saved = store.review_recipe(reviewed, canonicals, wordings)
    return ConfirmedBatch(recipe=saved, confirm_batch=batch, ready=ready)


@router.post(
    "/recipes/{recipe_id}/edit",
    dependencies=EDITORS_ONLY,
    responses={
        403: DUPLICATE[403],
        **NO_SUCH_RECIPE,
        409: {
            "description": "The recipe, or a Canonical Ingredient or wording the edit confirms, "
            "changed, or the recipe is Pending and has no facts to edit yet"
        },
        422: {
            "description": "The recipe has no such line, step or substitute, the step's portions "
            "and timers don't fit it or use more than all of a line, the line's wording changes "
            "without a Canonical Ingredient choice, the Canonical Ingredient or its Store Category "
            "doesn't exist, the line has no weight to keep or convert, or the edited recipe is "
            "too big to store"
        },
    },
)
def edit_fact(recipe_id: Annotated[Ulid, Path()], body: EditFact, store: StoreDep) -> EditedFact:
    """Save the editor's edit of one Review Item's facts on the recipe at `body.version`,
    Confirmed with provenance `editor` and in no Confirm Batch, and resolve its open Enrichment
    Issues. A recipe Awaiting Review with nothing left to review is Ready.

    A line's new Canonical Ingredient fixes the line's wording: the Wording Cache confirms it, and
    every recipe with a line of that wording is matched to it too, each at its own version. Once
    the edited recipe is saved, the edit never fails: a recipe that kept changing, or that the
    match would make too big, is listed in `not_updated`.
    """
    recipe = _recipe(store, recipe_id)
    if recipe.status == "pending":
        raise HTTPException(409, "A Pending recipe has no facts to edit yet")
    if recipe.version != body.version:
        raise VersionConflict(recipe.id)
    edited = edit_recipe(store, recipe, body.edit)
    if len(edited.recipe.model_dump_json().encode()) > MAX_RECIPE_BYTES:
        raise HTTPException(422, f"An edited recipe is at most {MAX_RECIPE_BYTES} bytes as JSON")
    saved = store.review_recipe(
        edited.recipe,
        edited.confirmed,
        edited.learned,
        created=edited.created,
        overwrite_wordings=edited.fixed,
    )
    also_updated, not_updated = share_all(store, edited)
    ready = recipe.status == "awaiting_review" and saved.status == "ready"
    return EditedFact(recipe=saved, ready=ready, also_updated=also_updated, not_updated=not_updated)


@router.post(
    "/recipes/{recipe_id}/confirm-batches/{batch}/undo",
    response_model=Recipe,
    dependencies=EDITORS_ONLY,
    responses={
        403: DUPLICATE[403],
        404: {"description": "No such recipe, or nothing on it is in the Confirm Batch"},
        409: {"description": "The recipe or a Canonical Ingredient changed meanwhile"},
    },
)
def undo_confirm_batch(
    recipe_id: Annotated[Ulid, Path()], batch: Annotated[Ulid, Path()], store: StoreDep
) -> Recipe:
    """Reverse one Confirm Batch on the recipe as it is now: unconfirm its facts, reopen its
    Enrichment Issues, move the recipe back to Awaiting Review if the batch made it Ready, and
    unconfirm each Canonical Ingredient it confirmed that still carries it. Wordings stay.
    """
    recipe = _recipe(store, recipe_id)
    facts = recipe.facts.model_copy(deep=True)
    paths = fact_paths(facts)
    undone = [p for p in paths if cast("Fact", fact_at(facts, p)).confirm_batch == batch]
    if not undone and all(issue.confirm_batch != batch for issue in recipe.issues):
        raise HTTPException(404, "Nothing on the recipe is in that Confirm Batch")
    canonicals: dict[str, CanonicalIngredient] = {}
    for path in undone:
        fact = cast("Fact", fact_at(facts, path))
        fact.confirmed, fact.confirmed_by, fact.confirmed_at, fact.confirm_batch = (
            False,
            None,
            None,
            None,
        )
        if isinstance(fact, MatchFact):
            canonical = store.canonical_ingredient(fact.canonical_id)
            if canonical and canonical.confirm_batch == batch:
                canonicals[canonical.id] = canonical.model_copy(
                    update={"confirmed": False, "confirm_batch": None}
                )
    changes: dict[str, object] = {
        "facts": facts,
        "issues": [
            issue.model_copy(update={"status": "open", "confirm_batch": None})
            if issue.confirm_batch == batch
            else issue
            for issue in recipe.issues
        ],
    }
    if recipe.ready_batch == batch:
        changes |= {"status": "awaiting_review", "ready_batch": None}
    return store.review_recipe(recipe.model_copy(update=changes), canonicals.values(), [])


def _check_lines(body: Enrichment, recipe: Recipe) -> None:
    """Refuse a fact for a line the recipe doesn't have, an Enrichment Issue on no line or step
    fact or not open, and a wording that isn't a parsed line's name.
    """
    lines = {line.id for line in recipe.original.ingredients}
    if unknown := sorted(body.facts.ingredients.keys() - lines):
        raise HTTPException(422, f"The recipe has no line {', '.join(unknown)}")
    steps = {step.id for step in recipe.original.steps}
    facts = (
        {f"{line}.{fact}" for line in lines for fact in IngredientFacts.model_fields}
        | {f"{step}.{fact}" for step in steps for fact in StepFacts.model_fields}
        | (RecipeFacts.model_fields.keys() - {"ingredients", "steps"})
    )
    if unknown := sorted({issue.fact_id for issue in body.issues} - facts):
        raise HTTPException(422, f"An Enrichment Issue is on no fact: {', '.join(unknown)}")
    # Only an editor's review settles an issue, never enrichment.
    if any(issue.status != "open" or issue.confirm_batch for issue in body.issues):
        raise HTTPException(422, "An Enrichment Issue arrives open, in no Confirm Batch")
    names = {
        normalize_wording(facts.parse.name)
        for facts in body.facts.ingredients.values()
        if facts.parse
    }
    if unknown := sorted({wording.wording for wording in body.wordings} - names):
        raise HTTPException(422, f"No parsed line is named {', '.join(unknown)}")


def _check_steps(body: Enrichment, recipe: Recipe) -> None:
    """Refuse a fact for a step the recipe doesn't have, a step's facts `_check_step` refuses, and
    a line used more than once over across the steps.
    """
    texts = {step.id: step.text for step in recipe.original.steps}
    if unknown := sorted(body.facts.steps.keys() - texts.keys()):
        raise HTTPException(422, f"The recipe has no step {', '.join(unknown)}")
    lines = {line.id for line in recipe.original.ingredients}
    for step_id, facts in body.facts.steps.items():
        _check_step(step_id, texts[step_id], facts, lines)
    if over := overused(body.facts.steps):
        raise HTTPException(422, f"The steps use more than all of {', '.join(over)}")


def _check_step(step_id: str, text: str, facts: StepFacts, lines: set[str]) -> None:
    """Refuse segments or uses naming a line the recipe doesn't have, a line used twice, segments
    that aren't the step's text, a duration or temperature that isn't what code finds where it's
    written, and, in a step with segments, uses that aren't its ingredient segments' portions
    summed per line.
    """
    uses = facts.uses.uses if facts.uses else []
    segments = facts.segments.segments if facts.segments else []
    named = {s.ref for s in segments if isinstance(s, IngredientSegment)}
    if unknown := sorted(({use.ref for use in uses} | named) - lines):
        raise HTTPException(422, f"The recipe has no line {', '.join(unknown)}")
    refs = [use.ref for use in uses]
    if twice := sorted({ref for ref in refs if refs.count(ref) > 1}):
        raise HTTPException(422, f"Step {step_id} uses {', '.join(twice)} twice")
    used = {use.ref: use.portion for use in uses}
    if facts.segments is None:
        return
    if "".join(written_as(segment) for segment in segments) != text:
        raise HTTPException(422, f"Step {step_id}'s segments aren't its text")
    found = {(start, segment.written): segment for start, segment in find_offers(text)}
    summed: dict[str, float] = {}
    at = 0
    for segment in segments:
        if isinstance(segment, DurationSegment | TemperatureSegment) and (
            found.get((at, segment.written)) != segment
        ):
            raise HTTPException(
                422, f"Step {step_id}'s {segment.written} isn't what code finds there"
            )
        if isinstance(segment, IngredientSegment):
            summed[segment.ref] = summed.get(segment.ref, 0) + segment.portion
        at += len(written_as(segment))
    if used.keys() != summed.keys() or any(
        abs(portion - summed[ref]) > PORTION_TOLERANCE for ref, portion in used.items()
    ):
        raise HTTPException(
            422, f"Step {step_id}'s uses aren't its ingredient segments' portions summed"
        )


def _check_suggestions(body: Enrichment) -> None:
    """Refuse substitutions or a suggested Difficulty that aren't the LLM's unconfirmed estimate,
    and a substitute that is its line's own Canonical Ingredient.
    """
    lines = body.facts.ingredients.values()
    suggestions: list[Fact] = [facts.substitutions for facts in lines if facts.substitutions]
    if body.facts.difficulty:
        suggestions.append(body.facts.difficulty)
    if any(
        fact.provenance != "llm"
        or not fact.estimated
        or fact.confirmed
        or fact.confirmed_by
        or fact.confirmed_at
        or fact.confirm_batch
        for fact in suggestions
    ):
        raise HTTPException(
            422, "Substitutions and a suggested Difficulty arrive as the LLM's unconfirmed estimate"
        )
    for facts in lines:
        match = facts.match.canonical_id if facts.match else None
        if any(item.canonical_id == match for item in _substitutes(facts)):
            raise HTTPException(422, "A substitute isn't its line's own Canonical Ingredient")


def _substitutes(facts: IngredientFacts) -> list[Substitution]:
    return facts.substitutions.items if facts.substitutions else []


def _check_canonical_ingredients(body: Enrichment, store: Store) -> None:
    """Refuse a match, substitute or wording for an unknown Canonical Ingredient, and a new one in
    a Store Category that isn't in the Kitchen settings.
    """
    categories = {category.id for category in store.kitchen_settings().store_categories}
    if any(new.store_category_id not in categories for new in body.canonical_ingredients):
        raise HTTPException(422, "A new Canonical Ingredient's Store Category doesn't exist")
    learned = [*body.canonical_ingredients, *body.wordings]
    if any(item.schema_version != SCHEMA_VERSION for item in learned):
        raise HTTPException(422, f"Each new item is at schema version {SCHEMA_VERSION}")
    # Only an editor's review confirms, never enrichment.
    if any(item.confirmed for item in learned):
        raise HTTPException(422, "A new Canonical Ingredient or wording isn't confirmed")
    known = {canonical.id for canonical in store.canonical_ingredients()} | {
        new.id for new in body.canonical_ingredients
    }
    lines = body.facts.ingredients.values()
    matched = (
        {facts.match.canonical_id for facts in lines if facts.match}
        | {item.canonical_id for facts in lines for item in _substitutes(facts)}
        | {wording.canonical_id for wording in body.wordings}
    )
    if unknown := sorted(matched - known):
        raise HTTPException(422, f"No Canonical Ingredient {', '.join(unknown)}")


@router.get("/queued-ingests", dependencies=EDITORS_ONLY, responses={403: DUPLICATE[403]})
def get_queued_ingests(store: StoreDep) -> list[QueuedIngest]:
    """The Sources waiting for a fallback or for an editor to paste the page, oldest first."""
    return store.queued_ingests()


NO_SUCH_QUEUED_INGEST: dict[int | str, dict[str, Any]] = {
    404: {"description": "No such Queued Ingest"}
}


@router.post(
    "/queued-ingests/{ingest_id}/recipe",
    response_model=Recipe,
    status_code=201,
    dependencies=EDITORS_ONLY,
    responses={
        403: DUPLICATE[403],
        **NO_SUCH_QUEUED_INGEST,
        409: {"description": "Another save of this Queued Ingest got there first"},
        422: {"description": "Not a valid recipe, not its Source, or an image isn't stored"},
    },
)
def post_queued_ingest_recipe(
    ingest_id: Annotated[Ulid, Path()], body: NewRecipe, store: StoreDep, images: ImagesDep
) -> Recipe:
    """Turn a Queued Ingest into the recipe a fallback captured, Pending enrichment: its Source
    guard moves to the recipe, and the Queued Ingest goes, all at once.
    """
    queued = _queued_ingest(store, ingest_id)
    key = _dedupe_key(body.source.url)
    if key != queued.dedupe_key:
        raise HTTPException(422, "That isn't the Queued Ingest's Source")
    return store.recipe_from_queued_ingest(_new_recipe(body, key, store, images), queued)


@router.post(
    "/queued-ingests/{ingest_id}/needs-page",
    dependencies=EDITORS_ONLY,
    responses={403: DUPLICATE[403], **NO_SUCH_QUEUED_INGEST},
)
def post_queued_ingest_needs_page(
    ingest_id: Annotated[Ulid, Path()], body: NeedsPage, store: StoreDep
) -> QueuedIngest:
    """Leave a waiting Queued Ingest for an editor to paste its page, every fallback having
    failed for `reason`. One that already needs its page stays as it is.
    """
    queued = store.mark_needs_page(ingest_id, body.reason)
    if queued is None:
        raise _no_such_queued_ingest()
    return queued


@router.post(
    "/queued-ingests/{ingest_id}/failed-attempt",
    dependencies=EDITORS_ONLY,
    responses={403: DUPLICATE[403], **NO_SUCH_QUEUED_INGEST},
)
def post_queued_ingest_failed_attempt(
    ingest_id: Annotated[Ulid, Path()], body: FailedAttempt, store: StoreDep
) -> QueuedIngest:
    """Record why a fallback's latest try at a waiting Queued Ingest failed, for a `reason` that
    may pass, leaving it waiting. One that needs its page stays as it is.
    """
    queued = store.record_failed_attempt(ingest_id, body.reason)
    if queued is None:
        raise _no_such_queued_ingest()
    return queued


@router.post(
    "/queued-ingests/{ingest_id}/pasted-page",
    response_model=Ingested,
    dependencies=EDITORS_ONLY,
    responses={
        403: DUPLICATE[403],
        **NO_SUCH_QUEUED_INGEST,
        413: {"description": f"The page is more than {MAX_PAGE_BYTES} bytes"},
        422: {"description": "No recipe in the page, or its Source isn't a website"},
    },
)
def post_queued_ingest_pasted_page(
    ingest_id: Annotated[Ulid, Path()], body: PastedPage, store: StoreDep
) -> Ingested:
    """Capture a recipe from the page an editor pasted for a Queued Ingest, for review, storing
    nothing. Scraped as the site the Source is on. Saving it finishes the Queued Ingest.
    """
    queued = _queued_ingest(store, ingest_id)
    if not isinstance(queued.source, WebsiteSource):
        raise HTTPException(422, "Only a website's Queued Ingest has a page to paste")
    try:
        size = len(body.html.encode())
    except UnicodeEncodeError:  # JSON can spell a lone surrogate, which isn't text
        raise HTTPException(422, "That page isn't valid text") from None
    if size > MAX_PAGE_BYTES:
        raise HTTPException(413, f"A page is at most {MAX_PAGE_BYTES} bytes")
    try:
        captured = parse(body.html, queued.source.url)
    except IngestFailed:
        raise HTTPException(422, "No recipe found in that page") from None
    source = WebsiteSource(
        url=queued.source.url,
        site_name=captured.site_name or site_host(queued.dedupe_key),
        captured_at=datetime.now(UTC),
    )
    original = captured.original.model_copy(update={"extractor": PASTED_EXTRACTOR})
    return Ingested(source=source, original=original, candidate_photos=captured.candidate_photos)


@router.delete(
    "/queued-ingests/{ingest_id}",
    status_code=204,
    response_class=Response,
    dependencies=EDITORS_ONLY,
    responses={
        403: DUPLICATE[403],
        **NO_SUCH_QUEUED_INGEST,
        409: {"description": "The Queued Ingest no longer reserves its Source"},
    },
)
def delete_queued_ingest(ingest_id: Annotated[Ulid, Path()], store: StoreDep) -> Response:
    """Discard a Queued Ingest, waiting or needing its page, with its Source guard, so its Source
    can be ingested again.
    """
    if not store.discard_queued_ingest(_queued_ingest(store, ingest_id)):
        raise _no_such_queued_ingest()
    return Response(status_code=204)


def _queued_ingest(store: Store, ingest_id: str) -> QueuedIngest:
    queued = store.queued_ingest(ingest_id)
    if queued is None:
        raise _no_such_queued_ingest()
    return queued


def _no_such_queued_ingest() -> HTTPException:
    return HTTPException(404, "No such Queued Ingest")


@router.patch(
    "/favorite-sites",
    response_model=CountedSites,
    dependencies=EDITORS_ONLY,
    responses={
        403: DUPLICATE[403],
        409: {"description": "The Favorite Sites changed since the editor read them"},
        422: {
            "description": "Not a valid edit, an operation names a site that isn't there, or the "
            "list would hold two sites on one host or too many sites"
        },
    },
)
def patch_favorite_sites(body: FavoriteSitesEdit, store: StoreDep) -> CountedSites:
    """Apply an editor's batch to the Favorite Sites at `body.version`, in one write."""
    current = store.favorite_sites()
    if current.version != body.version:
        raise VersionConflict(body.version)
    sites = _edited_sites(current.sites, body.operations)
    if len(sites) > MAX_FAVORITE_SITES:
        raise HTTPException(422, f"The list holds at most {MAX_FAVORITE_SITES} sites")
    hosts = [_site_host(site.address) for site in sites]
    if len(set(hosts)) < len(hosts):
        raise HTTPException(422, "Two sites are on the same host")
    saved = store.save_favorite_sites(current.model_copy(update={"sites": sites}))
    return _counted_sites(saved, store.cards())


def _edited_sites(
    current: list[FavoriteSite],
    operations: list[SiteOperation],
) -> list[FavoriteSite]:
    sites = list(current)
    for operation in operations:
        match operation:
            case RenameSite():
                _change_site(sites, operation.id, name=operation.name)
            case SetSiteAddress():
                _change_site(sites, operation.id, address=operation.address)
            case SetSiteNote():
                _change_site(sites, operation.id, note=operation.note)
            case ReorderSites():
                if sorted(operation.ids) != sorted(site.id for site in sites):
                    raise HTTPException(422, "A reorder names each site once")
                by_id = {site.id: site for site in sites}
                sites = [by_id[site_id] for site_id in operation.ids]
            case DeleteSite():
                del sites[_site_index(sites, operation.id)]
            case AddSite():
                sites.append(
                    FavoriteSite(
                        id=new_ulid(),
                        name=operation.name,
                        address=operation.address,
                        note=operation.note,
                    )
                )
    return sites


def _change_site(sites: list[FavoriteSite], site_id: str, **changes: str) -> None:
    index = _site_index(sites, site_id)
    sites[index] = sites[index].model_copy(update=changes)


def _site_index(sites: list[FavoriteSite], site_id: str) -> int:
    for index, site in enumerate(sites):
        if site.id == site_id:
            return index
    raise HTTPException(422, f"There is no site {site_id}")


def _site_host(address: str) -> str:
    """The host a Favorite Site matches cards on: any path in its address is ignored."""
    return site_host(_dedupe_key(address))


def _counted_sites(favorite_sites: FavoriteSites, cards: list[Card]) -> CountedSites:
    recipes = Counter(card.host for card in cards)
    return CountedSites(
        version=favorite_sites.version,
        sites=[
            CountedSite(**site.model_dump(), recipe_count=recipes[_site_host(site.address)])
            for site in favorite_sites.sites
        ],
    )


@router.patch(
    "/kitchen-settings",
    response_model=KitchenSettings,
    dependencies=EDITORS_ONLY,
    responses={
        403: DUPLICATE[403],
        409: {"description": "The Kitchen settings or a moved ingredient changed since read"},
        422: {
            "description": "Not a valid edit, an operation names a Store Category that isn't "
            "there, it deletes the last one, or two would have the same name"
        },
    },
)
def patch_kitchen_settings(body: KitchenSettingsEdit, store: StoreDep) -> KitchenSettings:
    """Apply an editor's batch to the Store Categories at `body.version`, moving the Canonical
    Ingredients of each one it deletes.
    """
    current = store.kitchen_settings()
    if current.version != body.version:
        raise VersionConflict(body.version)
    categories, moves = _edited_categories(current.store_categories, body.operations)
    names = {category.name.casefold() for category in categories}
    if len(names) < len(categories):
        raise HTTPException(422, "Two Store Categories have the same name")
    return store.save_store_categories(
        current.model_copy(update={"store_categories": categories}), moves
    )


def _edited_categories(
    current: list[StoreCategory],
    operations: list[StoreCategoryOperation],
) -> tuple[list[StoreCategory], dict[str, str]]:
    """The categories after the batch, and where each deleted one's ingredients end up: following
    a chain of deletes to its end, so a category that was itself deleted is never a destination.
    """
    categories = list(current)
    moves: dict[str, str] = {}
    for operation in operations:
        match operation:
            case AddStoreCategory():
                categories.append(StoreCategory(id=new_ulid(), name=operation.name))
            case RenameStoreCategory():
                index = _category_index(categories, operation.id)
                categories[index] = categories[index].model_copy(update={"name": operation.name})
            case ReorderStoreCategories():
                if sorted(operation.ids) != sorted(category.id for category in categories):
                    raise HTTPException(422, "A reorder names each Store Category once")
                by_id = {category.id: category for category in categories}
                categories = [by_id[category_id] for category_id in operation.ids]
            case DeleteStoreCategory():
                index = _category_index(categories, operation.id)
                if len(categories) == 1:
                    raise HTTPException(422, "The last Store Category can't be deleted")
                if operation.move_to == operation.id:
                    raise HTTPException(422, "A Store Category can't move into itself")
                _category_index(categories, operation.move_to)
                del categories[index]
                moves = {
                    moved: operation.move_to if to == operation.id else to
                    for moved, to in moves.items()
                }
                moves[operation.id] = operation.move_to
    return categories, moves


def _category_index(categories: list[StoreCategory], category_id: str) -> int:
    for index, category in enumerate(categories):
        if category.id == category_id:
            return index
    raise HTTPException(422, f"There is no Store Category {category_id}")


@router.patch(
    "/canonical-ingredients/{canonical_id}",
    response_model=CanonicalIngredient,
    dependencies=EDITORS_ONLY,
    responses={
        403: DUPLICATE[403],
        404: {"description": "No such Canonical Ingredient"},
        409: {"description": "It, or the Kitchen settings it was placed against, changed"},
        422: {"description": "Not a valid edit, or the Store Category isn't there"},
    },
)
def patch_canonical_ingredient(
    canonical_id: Annotated[Ulid, Path()], body: CanonicalIngredientEdit, store: StoreDep
) -> CanonicalIngredient:
    """Apply an editor's changes to a Canonical Ingredient at `body.version`, in one write.

    Choosing a Store Category also needs the Kitchen settings unchanged; a Pantry Staple doesn't.
    """
    current = store.canonical_ingredient(canonical_id)
    if current is None:
        raise HTTPException(404, "No such Canonical Ingredient")
    if current.version != body.version:
        raise VersionConflict(body.version)
    changes: dict[str, str | bool] = {}
    kitchen: KitchenSettings | None = None
    for operation in body.operations:
        match operation:
            case SetPantryStaple():
                changes["pantry_staple"] = operation.pantry_staple
            case SetStoreCategory():
                kitchen = kitchen or store.kitchen_settings()
                _category_index(kitchen.store_categories, operation.store_category_id)
                changes["store_category_id"] = operation.store_category_id
    return store.save_canonical_ingredient(
        current.model_copy(update=changes), kitchen_version=kitchen.version if kitchen else None
    )


def _dedupe_key(url: str) -> str:
    try:
        return website_dedupe_key(url)
    except InvalidUrl:
        raise HTTPException(422, "That isn't a website's address") from None


def _queued_state(failed: IngestFailed) -> QueuedIngestState:
    """A refused fetch needs an editor to paste the page; any other failure waits for the CLI."""
    return "needs_page" if isinstance(failed, FetchRefused) else "waiting"


def _duplicate(store: Store, key: str) -> JSONResponse | None:
    guard = store.source_guard(key)
    return None if guard is None else _conflict(guard.recipe_id, guard.queued_ingest_id)


def _claimed(store: Store, key: str) -> JSONResponse:
    """The 409 for a write that found the Source's guard: the duplicate it names, or a retry when
    the guard has gone again by the time it's read.
    """
    return _duplicate(store, key) or _conflict(None, None)


def _conflict(recipe_id: str | None, queued_ingest_id: str | None) -> JSONResponse:
    if recipe_id:
        detail = "Already in the Collection"
    elif queued_ingest_id:
        detail = "Already waiting to be ingested"
    else:
        detail = "Try again"
    duplicate = Duplicate(detail=detail, recipe_id=recipe_id, queued_ingest_id=queued_ingest_id)
    return JSONResponse(duplicate.model_dump(mode="json"), status_code=409, headers=NO_STORE)


def _tags(tags: list[str], store: Store, editing: str | None = None) -> list[str]:
    """Tags match case-insensitively across the Collection, keeping the spelling another
    recipe's card already uses, or else the first given here.
    """
    spelled: dict[str, str] = {}
    for card in store.cards():
        if card.id != editing:
            for tag in card.tags:
                spelled.setdefault(tag.casefold(), tag)
    kept: dict[str, str] = {}
    for tag in (t.strip() for t in tags):
        if tag:
            kept.setdefault(tag.casefold(), spelled.get(tag.casefold(), tag))
    return list(kept.values())


def version_conflict(_request: Request, _exc: Exception) -> JSONResponse:
    return JSONResponse(
        {"detail": "Version conflict: reload and try again"}, status_code=409, headers=NO_STORE
    )


def invalid_request(_request: Request, exc: Exception) -> JSONResponse:
    # FastAPI reads NaN and Infinity in a JSON body, which JSON can't write back, so a 422 names
    # each error without the input that caused it.
    errors = cast("RequestValidationError", exc).errors()
    detail = [{key: value for key, value in error.items() if key != "input"} for error in errors]
    return JSONResponse({"detail": jsonable_encoder(detail)}, status_code=422)


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
    *,
    store: Callable[[], Store] = Store.from_env,
    auth: Callable[[], Auth] = Auth.from_env,
    fetcher: Callable[[], Fetcher] = PoliteFetcher,
    images: Callable[[], ImageStore] = ImageStore.from_env,
) -> FastAPI:
    """The API on the table `store` opens, signing editors in with `auth`, fetching websites
    with `fetcher` and keeping photos in the bucket `images` opens. On startup it bootstraps the
    table, or refuses to start on another schema. Sign-in reads its settings on first need.
    """

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None]:
        opened = store()
        opened.bootstrap()
        app.state.store = opened
        app.state.auth = auth()
        app.state.fetcher = fetcher()
        app.state.images = images()
        yield

    app = FastAPI(title="Plateful", lifespan=lifespan)
    app.include_router(router)
    app.include_router(auth_router)
    app.middleware("http")(no_store_by_default)
    app.middleware("http")(noindex)
    app.add_exception_handler(VersionConflict, version_conflict)
    app.add_exception_handler(RequestValidationError, invalid_request)
    app.add_exception_handler(Exception, server_error)
    return app


app = create_app()
