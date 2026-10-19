"""The domain model: one shape for DynamoDB items and the API (recipe data model ADR).

Enrichment facts (parses, matches, segments, issues) and Our Version join these models when the
features that write them arrive.
"""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

SCHEMA_VERSION = 1

# A ULID in Crockford base32. The first character is at most 7, since the timestamp is 48 bits.
Ulid = Annotated[str, StringConstraints(pattern=r"^[0-7][0-9A-HJKMNP-TV-Z]{25}$")]
Rating = Annotated[int, Field(ge=1, le=3)]


class Model(BaseModel):
    # Every field is in what the API sends, defaults included, so the generated client says so.
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)


class WebsiteSource(Model):
    kind: Literal["website"] = "website"
    url: str
    site_name: str
    captured_at: datetime


class SpreadsheetSource(Model):
    kind: Literal["spreadsheet"] = "spreadsheet"
    url: str
    sheet_id: str
    entry_name: str
    captured_at: datetime


Source = Annotated[WebsiteSource | SpreadsheetSource, Field(discriminator="kind")]


class IngredientLine(Model):
    id: str
    component: str | None = None
    text: str


class Step(Model):
    id: str
    component: str | None = None
    text: str


class RecipeYield(Model):
    text: str
    servings: int | None = None
    unit: str | None = None


class StatedTime(Model):
    """A Stated Time as written, with its seconds when the text could be read."""

    text: str
    seconds: int | None = None


class StatedTimes(Model):
    prep: StatedTime | None = None
    cook: StatedTime | None = None
    total: StatedTime | None = None


class Original(Model):
    """The recipe exactly as captured from its Source."""

    # `yield` is a Python keyword, so the field has another name in code only.
    model_config = ConfigDict(validate_by_name=True, serialize_by_alias=True)

    title: str
    description: str | None = None
    author: str | None = None
    extractor: str
    ingredients: list[IngredientLine]
    steps: list[Step]
    recipe_yield: RecipeYield | None = Field(
        default=None, validation_alias="yield", serialization_alias="yield"
    )
    stated_times: StatedTimes = StatedTimes()


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


class SchemaMeta(Model):
    """`META#schema`: the schema version of every item in the table."""

    schema_version: int
