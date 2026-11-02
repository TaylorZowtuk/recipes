"""The HTTP API that CloudFront routes `/api/*` to."""

import re
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Annotated, Any, Literal, cast

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Path, Query, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, BeforeValidator, Field, StringConstraints, model_validator

from recipes.auth import Auth, require_editor
from recipes.auth import router as auth_router
from recipes.images import IMMUTABLE, ImageStore, NotAnImage, TooManyPixels
from recipes.ingest import (
    Fetcher,
    FetchRefused,
    IngestFailed,
    InvalidUrl,
    PageNotFound,
    PoliteFetcher,
    TooLarge,
    parse,
    site_host,
    website_dedupe_key,
)
from recipes.models import (
    MAX_RECIPE_BYTES,
    PORTION_TOLERANCE,
    SCHEMA_VERSION,
    CanonicalIngredient,
    Card,
    Difficulty,
    DurationSegment,
    Enrichment,
    Image,
    IngredientFacts,
    IngredientSegment,
    KitchenSettings,
    Original,
    Preview,
    QueuedIngest,
    QueuedIngestState,
    Recipe,
    StepFacts,
    TemperatureSegment,
    Ulid,
    WebsiteSource,
    WebUrl,
    Wording,
    new_ulid,
    normalize_wording,
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


class Collection(BaseModel):
    """Everything a phone caches about the Collection, at one collection version."""

    collection_version: int
    cards: list[Card]
    canonical_ingredients: list[CanonicalIngredient]
    wordings: list[Wording]  # the Wording Cache
    kitchen_settings: KitchenSettings


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


@router.get("/sync")
def get_sync(store: StoreDep, response: Response) -> Sync:
    response.headers.update(NO_STORE)
    return Sync(
        collection_version=store.collection_version(),
        schema_version=SCHEMA_VERSION,
        read_only=None,
        weeks=None,
    )


@router.get("/collection", status_code=307, response_class=RedirectResponse, responses=TO_CURRENT)
def get_current_collection(store: StoreDep) -> RedirectResponse:
    """Redirects to the Collection at its current version."""
    return _redirect(_collection_path(store.collection_version()))


# Everything under /api/v/ is cached by CloudFront for whoever asks, so no route there may
# check for an editor: that answer depends on the cookie, and may re-issue it.
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
    return Collection(
        collection_version=current,
        cards=store.cards(),
        canonical_ingredients=store.canonical_ingredients(),
        wordings=store.wordings(),
        kitchen_settings=store.kitchen_settings(),
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
    if not all(images.exists(image.id) for image in body.images):
        raise HTTPException(422, "Store each image with POST /api/images first")
    recipe = Recipe(
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
    try:
        return store.add_recipe(recipe)
    except DuplicateSource:
        return _claimed(store, key)


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
            "doesn't have, a line's portions add up to more than 1, an issue isn't open, a "
            "wording isn't a parsed line's name, it learns more than one write holds, a fact "
            "names an unknown Canonical Ingredient or Store Category, or a new Canonical "
            "Ingredient or wording is confirmed or at another schema version, or the enriched "
            "recipe is too big to store"
        },
    },
)
def put_enrichment(recipe_id: Annotated[Ulid, Path()], body: Enrichment, store: StoreDep) -> Recipe:
    """Store a Pending recipe's facts and Enrichment Issues, with the Canonical Ingredients they
    create and the wordings they learn. A bulk import's recipe is then Ready, and any other waits
    in Awaiting Review for an editor to check it.

    Refused unless every fact is for one of the recipe's lines or steps, every step's segments
    are its text exactly and name only its lines, as do its uses, no step uses a line twice, every
    duration or temperature segment is one code finds in its step's text, a step with segments has
    uses that are exactly its segments' Step Portions summed per line, each line's `portion`s across
    the steps add up to at most 1, every Enrichment Issue is on one of their facts and arrives open
    with no confirm batch, every wording is the normalized
    name of one of the parsed lines, it learns at most MAX_LEARNED items, every match and wording
    names a Canonical Ingredient that exists or is new here, every new one's Store Category
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
            "status": "ready" if recipe.ingest_channel == "bulk_import" else "awaiting_review",
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
    `body.version`, with its card, in one write.
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
    return store.update_recipe(recipe.model_copy(update=changes))


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


def _check_lines(body: Enrichment, recipe: Recipe) -> None:
    """Refuse a fact for a line the recipe doesn't have, an Enrichment Issue on no line or step
    fact or not open, and a wording that isn't a parsed line's name.
    """
    lines = {line.id for line in recipe.original.ingredients}
    if unknown := sorted(body.facts.ingredients.keys() - lines):
        raise HTTPException(422, f"The recipe has no line {', '.join(unknown)}")
    steps = {step.id for step in recipe.original.steps}
    facts = {f"{line}.{fact}" for line in lines for fact in IngredientFacts.model_fields} | {
        f"{step}.{fact}" for step in steps for fact in StepFacts.model_fields
    }
    if unknown := sorted({issue.fact_id for issue in body.issues} - facts):
        raise HTTPException(422, f"An Enrichment Issue is on no fact: {', '.join(unknown)}")
    # Only an editor's review settles an issue, never enrichment.
    if any(issue.status != "open" or issue.confirm_batch for issue in body.issues):
        raise HTTPException(422, "An Enrichment Issue arrives open, in no confirm batch")
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
    portions: dict[str, float] = {}
    for step_id, facts in body.facts.steps.items():
        _check_step(step_id, texts[step_id], facts, lines)
        for use in facts.uses.uses if facts.uses else []:
            portions[use.ref] = portions.get(use.ref, 0) + use.portion
    if over := sorted(ref for ref, total in portions.items() if total > 1 + PORTION_TOLERANCE):
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


def _check_canonical_ingredients(body: Enrichment, store: Store) -> None:
    """Refuse a match or wording for an unknown Canonical Ingredient, and a new one in a Store
    Category that isn't in the Kitchen settings.
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
    matched = {
        facts.match.canonical_id for facts in body.facts.ingredients.values() if facts.match
    } | {wording.canonical_id for wording in body.wordings}
    if unknown := sorted(matched - known):
        raise HTTPException(422, f"No Canonical Ingredient {', '.join(unknown)}")


@router.get("/queued-ingests", dependencies=EDITORS_ONLY, responses={403: DUPLICATE[403]})
def get_queued_ingests(store: StoreDep) -> list[QueuedIngest]:
    """The Sources waiting for a fallback or for an editor to paste the page, oldest first."""
    return store.queued_ingests()


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
