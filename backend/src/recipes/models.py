"""The domain model: one shape for DynamoDB items and the API (recipe data model ADR).

Enrichment facts (parses, matches, segments, issues) and Our Version join these models when the
features that write them arrive.
"""

import secrets
from datetime import UTC, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

SCHEMA_VERSION = 1

# A ULID in Crockford base32. The first character is at most 7, since the timestamp is 48 bits.
Ulid = Annotated[str, StringConstraints(pattern=r"^[0-7][0-9A-HJKMNP-TV-Z]{25}$")]
_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
Rating = Annotated[int, Field(ge=1, le=3)]
# A website's dedupe key, under DynamoDB's 2048-byte key with room for the guard's `SOURCE#` prefix.
MAX_KEY_BYTES = 2000
# A Source's link: http(s) in any case, since it's rendered as a link. The string is kept exactly,
# and no longer than a key, so tracking parameters dropped from the key can't swell the item.
WebUrl = Annotated[str, StringConstraints(pattern=r"(?i)^https?://\S+$", max_length=MAX_KEY_BYTES)]
# An Original's limits, so a save past them is a 422 rather than an item past DynamoDB's 400 KB:
# each field's, and its whole size as JSON, which leaves the rest of the item room.
MAX_LABEL = 200
Line = Annotated[str, StringConstraints(max_length=2000)]
Label = Annotated[str, StringConstraints(max_length=MAX_LABEL)]
MAX_LINES = 500
MAX_ORIGINAL_BYTES = 350 * 1024


def new_ulid() -> str:
    """A new ULID: the time in milliseconds, then 80 random bits, so ids sort by creation."""
    value = int(datetime.now(UTC).timestamp() * 1000) << 80 | secrets.randbits(80)
    return "".join(_CROCKFORD[value >> shift & 31] for shift in range(125, -1, -5))


class Model(BaseModel):
    # Every field is in what the API sends, defaults included, so the generated client says so.
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)


class WebsiteSource(Model):
    kind: Literal["website"] = "website"
    url: WebUrl
    site_name: Label
    captured_at: datetime


class SpreadsheetSource(Model):
    kind: Literal["spreadsheet"] = "spreadsheet"
    url: WebUrl
    sheet_id: str
    entry_name: str
    captured_at: datetime


Source = Annotated[WebsiteSource | SpreadsheetSource, Field(discriminator="kind")]


class IngredientLine(Model):
    id: Label
    component: Label | None = None
    text: Line


class Step(Model):
    id: Label
    component: Label | None = None
    text: Line


class RecipeYield(Model):
    text: Label
    servings: int | None = None
    unit: str | None = None


class StatedTime(Model):
    """A Stated Time as written, with its seconds when the text could be read."""

    text: Label
    seconds: int | None = None


class StatedTimes(Model):
    prep: StatedTime | None = None
    cook: StatedTime | None = None
    total: StatedTime | None = None


class Original(Model):
    """The recipe exactly as captured from its Source."""

    # `yield` is a Python keyword, so the field has another name in code only.
    model_config = ConfigDict(validate_by_name=True, serialize_by_alias=True)

    title: Annotated[str, StringConstraints(max_length=300)]
    description: Annotated[str, StringConstraints(max_length=5000)] | None = None
    author: Label | None = None
    extractor: Label
    ingredients: Annotated[list[IngredientLine], Field(max_length=MAX_LINES)]
    steps: Annotated[list[Step], Field(max_length=MAX_LINES)]
    recipe_yield: RecipeYield | None = Field(
        default=None, validation_alias="yield", serialization_alias="yield"
    )
    stated_times: StatedTimes = StatedTimes()

    @model_validator(mode="after")
    def _fits_an_item(self) -> Original:
        if len(self.model_dump_json().encode()) > MAX_ORIGINAL_BYTES:
            msg = f"An Original is at most {MAX_ORIGINAL_BYTES} bytes as JSON"
            raise ValueError(msg)
        return self


class Difficulty(Model):
    prep: Rating
    cook: Rating
    cleanup: Rating


class Image(Model):
    id: str  # content hash
    width: int
    height: int
    origin: str


class Preview(Model):
    image_id: str
    focal_x: float
    focal_y: float


EnrichmentStatus = Literal["pending", "awaiting_review", "ready"]
# How a recipe came into the Collection: "add_a_recipe" is an editor adding it from a website.
IngestChannel = Literal["add_a_recipe"]


class Recipe(Model):
    id: Ulid
    schema_version: int
    version: int
    source: Source
    dedupe_key: str
    original: Original
    tags: list[str] = []
    difficulty: Difficulty | None = None
    images: list[Image] = []
    preview: Preview | None = None
    status: EnrichmentStatus
    ingest_channel: IngestChannel | None = None


class NeedsReview(Model):
    open_issues: int
    unconfirmed: int


class Card(Model):
    """A recipe's small summary for the Collection grid, kept up to date on every recipe write."""

    id: Ulid
    schema_version: int
    title: str
    site_name: str | None
    stated_seconds: int | None
    difficulty: Difficulty | None
    tags: list[str]
    status: EnrichmentStatus
    preview: Preview | None
    needs_review: NeedsReview
    recipe_version: int


def stated_seconds(times: StatedTimes) -> int | None:
    """The stated total, or else prep + cook when both are stated."""
    if times.total and times.total.seconds is not None:
        return times.total.seconds
    prep = times.prep.seconds if times.prep else None
    cook = times.cook.seconds if times.cook else None
    return None if prep is None or cook is None else prep + cook


def card_for(recipe: Recipe) -> Card:
    """Card upkeep: the card is derived from its recipe and nothing else."""
    return Card(
        id=recipe.id,
        schema_version=recipe.schema_version,
        title=recipe.original.title,
        site_name=recipe.source.site_name if isinstance(recipe.source, WebsiteSource) else None,
        stated_seconds=stated_seconds(recipe.original.stated_times),
        difficulty=recipe.difficulty,
        tags=recipe.tags,
        status=recipe.status,
        preview=recipe.preview,
        # Enrichment issues and facts aren't stored yet, so there's nothing to review.
        needs_review=NeedsReview(open_issues=0, unconfirmed=0),
        recipe_version=recipe.version,
    )


class StoreCategory(Model):
    id: str
    name: str


class KitchenSettings(Model):
    schema_version: int
    version: int
    store_categories: list[StoreCategory]  # in the order the Grocery List shows them


class CollectionMeta(Model):
    """`META#collection`: bumped by every write to shared collection data."""

    schema_version: int
    collection_version: int


class SourceGuard(Model):
    """`SOURCE#<dedupe key>`: claims a Source for the one recipe taken from it, or for the Queued
    Ingest that reserves it until that recipe is ingested.
    """

    schema_version: int
    recipe_id: Ulid | None = None
    queued_ingest_id: Ulid | None = None

    @model_validator(mode="after")
    def _points_at_one(self) -> SourceGuard:
        if (self.recipe_id is None) == (self.queued_ingest_id is None):
            msg = "A Source guard points at a recipe or a Queued Ingest"
            raise ValueError(msg)
        return self


# `waiting` is for the CLI's fallbacks; `needs_page` waits for an editor to paste the page.
QueuedIngestState = Literal["waiting", "needs_page"]
# Why the automated ingest stopped: robots.txt refused it, the site answered 403 or another 4xx
# or led off the public internet (blocked), 429 (rate_limited) or 5xx (server_error), it was
# unreachable, or had no recipe.
QueuedIngestReason = Literal[
    "robots", "blocked", "rate_limited", "server_error", "unreachable", "no_recipe"
]


class QueuedIngest(Model):
    """`INGEST` / `<id>`: a Source an automated ingest couldn't capture, kept until a fallback does.
    Not a recipe, so it has no card and isn't in the Collection.
    """

    schema_version: int
    id: Ulid
    source: Source
    dedupe_key: str
    state: QueuedIngestState
    reason: QueuedIngestReason
    queued_at: datetime


class SchemaMeta(Model):
    """`META#schema`: the schema version of every item in the table."""

    schema_version: int
