"""The domain model: one shape for DynamoDB items and the API (recipe data model ADR).

The other enrichment facts (substitutions) and Our Version join these models when the features
that write them arrive.
"""

import secrets
import string
from datetime import UTC, datetime
from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)

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
# A whole recipe as JSON, below DynamoDB's 400 KB item limit with room for its other attributes.
MAX_RECIPE_BYTES = 390_000
# A photo's content hash (recipes.images.image_id), which names its objects in the images bucket.
ImageId = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{32}$")]
# Where a focal point sits across or down its photo, from 0 at the left or top to 1.
Fraction = Annotated[float, Field(ge=0, le=1)]


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
    id: ImageId
    width: Annotated[int, Field(gt=0)]
    height: Annotated[int, Field(gt=0)]
    origin: WebUrl  # where the photo was fetched from


class Preview(Model):
    """A recipe's Preview Photo, cropped round about its Focal Point."""

    image_id: ImageId
    focal_x: Fraction
    focal_y: Fraction


EnrichmentStatus = Literal["pending", "awaiting_review", "ready"]
# How a recipe came into the Collection: "add_a_recipe" is an editor adding it from a website, and
# "bulk_import" skips Awaiting Review once enriched.
IngestChannel = Literal["add_a_recipe", "bulk_import"]


Amount = Annotated[float, Field(ge=0, allow_inf_nan=False)]


class Quantity(Model):
    """An amount as a range, with `low` equal to `high` for a single value."""

    low: Amount
    high: Amount

    @model_validator(mode="after")
    def _runs_upward(self) -> Quantity:
        if self.high < self.low:
            msg = "A quantity's high is at least its low"
            raise ValueError(msg)
        return self


class Fact(Model):
    """What every enriched fact records: where it came from, and whether an editor confirmed it."""

    provenance: Literal["source", "parser", "fdc", "llm", "editor"]
    confidence: Fraction
    estimated: bool
    confirmed: bool = False
    confirmed_by: Label | None = None
    confirmed_at: datetime | None = None
    confirm_batch: Label | None = None


class ParseFact(Fact):
    """An ingredient line read into its parts. No quantity means no amount, as in "to taste"."""

    quantity: Quantity | None
    unit: Label | None
    unit_kind: Literal["mass", "volume", "count"] | None
    name: Label
    short_name: Label | None = None
    preparation: Label | None
    comment: Label | None = None  # the line's remark: "or to taste", "plus more for serving"
    optional: bool = False  # "optional", "for garnish" or "to serve"


class MatchFact(Fact):
    """The line's Canonical Ingredient, with the FDC food and portion row the model chose."""

    canonical_id: Ulid
    fdc_id: int
    portion_id: int | None


# The FDC Snapshot's two datasets.
Dataset = Literal["foundation", "sr_legacy"]


# A nutrient as FDC states it, which may be a little below zero: carbohydrate "by difference"
# is what's left of 100 g after the rest, rounding and all.
Nutrient = Annotated[float, Field(allow_inf_nan=False)]


class Per100g(Model):
    """The FDC Snapshot's nutrition for 100 g of the matched food, as FDC states it."""

    kcal: Nutrient | None
    protein_g: Nutrient | None
    fat_g: Nutrient | None
    carbs_g: Nutrient | None
    sodium_mg: Nutrient | None


class ConversionFact(Fact):
    """How the line converts to grams, copied from the FDC Snapshot: a density for a volume, the
    grams in one count unit for a count, or the reason it doesn't convert.
    """

    fdc_id: int
    dataset: Dataset
    release: Label
    density_g_per_ml: Amount | None
    grams_per_count: Amount | None
    count_unit: Label | None
    refused: Label | None
    per_100g: Per100g


class IngredientFacts(Model):
    parse: ParseFact | None = None
    match: MatchFact | None = None
    conversion: ConversionFact | None = None


class TextSegment(Model):
    t: Literal["text"] = "text"
    v: Line


# How much of an ingredient line a step uses: more than none, and at most all of it.
Portion = Annotated[float, Field(gt=0, le=1, allow_inf_nan=False)]
# How far past 1 a line's portions may add up to, for floating point: nine ninths.
PORTION_TOLERANCE = 1e-9


class IngredientSegment(Model):
    """Where a step names an ingredient line, which renders its amount times its portion, scaled."""

    t: Literal["ingredient"] = "ingredient"
    ref: Label  # the ingredient line's id
    written: Line
    portion: Portion  # of the line, used where the step names it here


Seconds = Annotated[int, Field(ge=0)]


class DurationSegment(Model):
    """A time written in a step, as a range in seconds: a timer chimes at its low end."""

    t: Literal["duration"] = "duration"
    low_s: Seconds
    high_s: Seconds
    written: Line

    @model_validator(mode="after")
    def _runs_upward(self) -> DurationSegment:
        if self.high_s < self.low_s:
            msg = "A duration's high_s is at least its low_s"
            raise ValueError(msg)
        return self


class TemperatureSegment(Model):
    """A temperature written in a step, in whole degrees Celsius."""

    t: Literal["temperature"] = "temperature"
    c: int
    written: Line


Segment = Annotated[
    TextSegment | IngredientSegment | DurationSegment | TemperatureSegment,
    Field(discriminator="t"),
]


def written_as(segment: Segment) -> str:
    """The words of the step's text a segment is."""
    return segment.v if isinstance(segment, TextSegment) else segment.written


class SegmentsFact(Fact):
    """A step's text split into typed pieces, in order, which together are its text exactly."""

    segments: Annotated[list[Segment], Field(max_length=MAX_LINES)]


class StepUse(Model):
    ref: Label  # the ingredient line's id
    portion: Portion


class UsesFact(Fact):
    """The ingredient lines a step uses, with how much of each. Across all of a recipe's steps,
    an ingredient's portions add up to at most 1.
    """

    uses: Annotated[list[StepUse], Field(max_length=MAX_LINES)]


class StepFacts(Model):
    segments: SegmentsFact | None = None
    uses: UsesFact | None = None


class RecipeFacts(Model):
    """A recipe's facts, kept apart from its Original. A fact's path is its id: `i3.parse` is
    `ingredients["i3"].parse`, and `s2.uses` is `steps["s2"].uses`.
    """

    ingredients: dict[str, IngredientFacts] = {}
    steps: dict[str, StepFacts] = {}


class EnrichmentIssue(Model):
    """Something enrichment corrected or was unsure about, on the fact `fact_id` names."""

    id: Ulid
    fact_id: Label  # e.g. "i3.match"
    before: Line | None = None
    after: Line | None = None
    reason: Line
    model: Label | None = None
    status: Literal["open", "resolved"] = "open"
    confirm_batch: Label | None = None


def normalize_wording(name: str) -> str:
    """The Wording Cache's key for an ingredient's name: lowercase, with its whitespace collapsed
    and the punctuation around it stripped. Plurals stay as written.
    """
    return " ".join(name.lower().split()).strip(string.punctuation + string.whitespace)


def _normalized(name: str) -> str:
    wording = normalize_wording(name)
    if not wording:
        msg = "A wording is more than punctuation"
        raise ValueError(msg)
    return wording


class CanonicalIngredient(Model):
    """`CANON` / `<id>`: the one name every wording of an ingredient maps to."""

    id: Ulid
    name: Label
    family: Annotated[Label, AfterValidator(str.lower)]  # e.g. "chicken"
    store_category_id: str  # one of the Kitchen settings' Store Categories
    pantry_staple: bool = False
    confirmed: bool = False
    version: int
    schema_version: int


class Wording(Model):
    """`WORDING` / `<wording>`: the Wording Cache's entry for one normalized wording. Enrichment
    may replace it until an editor confirms it.
    """

    wording: Annotated[Label, AfterValidator(_normalized)]
    canonical_id: Ulid
    confirmed: bool = False
    schema_version: int


# The most Enrichment Issues one enrichment raises, so it can't swell the recipe item.
MAX_ISSUES = 200


class Enrichment(Model):
    """What the enrich CLI found in a Pending recipe, keyed by the Original's line ids, with the
    Canonical Ingredients it creates and the wordings it learns.
    """

    enrichment_version: int
    fdc_release: Label | None = None
    facts: RecipeFacts
    issues: Annotated[list[EnrichmentIssue], Field(max_length=MAX_ISSUES)] = []
    canonical_ingredients: list[CanonicalIngredient] = []
    wordings: list[Wording] = []

    @model_validator(mode="after")
    def _each_once(self) -> Enrichment:
        ids = [canonical.id for canonical in self.canonical_ingredients]
        wordings = [wording.wording for wording in self.wordings]
        if len(set(ids)) < len(ids) or len(set(wordings)) < len(wordings):
            msg = "Each Canonical Ingredient and wording is in an enrichment once"
            raise ValueError(msg)
        return self


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
    facts: RecipeFacts = RecipeFacts()
    enrichment_version: int | None = None
    fdc_release: Label | None = None
    issues: list[EnrichmentIssue] = []


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
        # Unconfirmed facts aren't counted yet.
        needs_review=NeedsReview(
            open_issues=sum(issue.status == "open" for issue in recipe.issues), unconfirmed=0
        ),
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
