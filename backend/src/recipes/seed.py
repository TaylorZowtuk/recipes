"""A synthetic Collection for `make dev` and the end-to-end tests, written for this repo.

`load` adds it through the store, so the cards and `META#collection` come from card upkeep,
giving the recipes in PHOTOS a generated placeholder photo. The end-to-end tests rely on
E2E_RECIPE_ID and E2E_RECIPE_TITLE: a Ready recipe with components, whose slug is
"sesame-noodles-with-crispy-tofu", and on Tomato Lentil Soup, whose only Difficulty is
enrichment's suggestion. Garlic Butter Green Beans awaits review with a new Canonical Ingredient,
a conversion, an open Enrichment Issue and a confirmed substitute for its butter. PANTRY holds
Canonical Ingredients no recipe uses, for Kitchen settings' tests to change freely. Its Favorite
Sites are on reserved domains, and the first is on example.com, so it counts the website recipes.
As enrichment does, every line of a recipe past Pending has a parse fact; Overnight Oats has a
line in cups and one in ounces, for the Adjust sheet's units. Lemon Herb Roast Chicken has an Our
Version: less salt, garlic for the thyme, an edited step waiting for enrich, and a note.
For a Week Plan's Grocery List, the Ready recipes' lines match GROCERY's Canonical Ingredients
across several Store Categories: onion counts in the chicken and the soup sum, plain yogurt (a
mass in the oats, a volume in the soup, both checked) becomes one mass, green onion (a range of
counts in the noodles, a volume in the soup, unchecked) stays subtotals, the soup's crushed
tomatoes are a sized can, and its salt is to taste. Their olive oil and carrots are unmatched,
under Other. The Taco Seasoning's parts wait for Ratio Recipes, so its lines are unmatched too.
"""

import io
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Literal

from PIL import Image, ImageDraw

from recipes import fdc
from recipes.models import (
    SCHEMA_VERSION,
    AddedLine,
    CanonicalIngredient,
    ConversionFact,
    Difficulty,
    DifficultyFact,
    DurationSegment,
    EnrichmentIssue,
    FavoriteSite,
    IngredientFacts,
    IngredientLine,
    IngredientSegment,
    MatchFact,
    Original,
    OurLine,
    OurLines,
    OurStep,
    OurSteps,
    OurVersion,
    ParseFact,
    Preview,
    Quantity,
    Recipe,
    RecipeFacts,
    RecipeYield,
    Segment,
    SegmentsFact,
    SpreadsheetSource,
    StatedTime,
    StatedTimes,
    Step,
    StepFacts,
    StepUse,
    Substitution,
    SubstitutionsFact,
    TemperatureSegment,
    TextSegment,
    UsesFact,
    WebsiteSource,
    Wording,
)

if TYPE_CHECKING:
    from recipes.images import ImageStore
    from recipes.store import Store

CAPTURED_AT = datetime(2026, 9, 1, 12, tzinfo=UTC)

E2E_RECIPE_ID = "01K7SEED000000000000000002"
E2E_RECIPE_TITLE = "Sesame Noodles with Crispy Tofu"
REVIEW_RECIPE_ID = "01K7SEED000000000000000007"

# What enrichment learned from the recipe awaiting review: a new, unconfirmed Canonical Ingredient
# and the wording that maps to it.
BUTTER = CanonicalIngredient(
    id="01K7SEED0000000000000000C1",
    name="butter",
    family="butter",
    store_category_id="dairy",
    version=1,
    schema_version=SCHEMA_VERSION,
)
# Butter's FDC food and its tablespoon portion in the committed FDC Snapshot, which make dev and
# the end-to-end tests look foods up in.
BUTTER_FDC_ID = 173410  # Butter, salted (SR Legacy)
BUTTER_TBSP = 92457
# The butter line's substitute, its own new Canonical Ingredient as a substitute must be: Butter,
# without salt (SR Legacy) by the tablespoon.
UNSALTED_BUTTER = CanonicalIngredient(
    id="01K7SEED0000000000000000C6",
    name="unsalted butter",
    family="butter",
    store_category_id="dairy",
    version=1,
    schema_version=SCHEMA_VERSION,
)
UNSALTED_FDC_ID = 173430
UNSALTED_TBSP = 92512
# Seeds, sesame butter, tahini, from roasted and toasted kernels (SR Legacy), by the tablespoon.
TAHINI_FDC_ID = 170189
TAHINI_TBSP = 86209
# The garlic Our Version adds to the roast chicken, as an editor picks it: a Canonical Ingredient
# and its wording, Confirmed, and Garlic, raw (SR Legacy) by the clove.
GARLIC = CanonicalIngredient(
    id="01K7SEED0000000000000000C7",
    name="garlic",
    family="garlic",
    store_category_id="produce",
    confirmed=True,
    version=1,
    schema_version=SCHEMA_VERSION,
)
GARLIC_WORDING = Wording(
    wording="garlic cloves", canonical_id=GARLIC.id, confirmed=True, schema_version=SCHEMA_VERSION
)
GARLIC_FDC_ID = 169230
GARLIC_CLOVE = 84480
CHICKEN_ID = "01K7SEED000000000000000001"
BUTTER_WORDING = Wording(wording="butter", canonical_id=BUTTER.id, schema_version=SCHEMA_VERSION)
PANTRY = [
    CanonicalIngredient(
        id=f"01K7SEED0000000000000000C{n}",
        name=name,
        family=family,
        store_category_id=category,
        pantry_staple=staple,
        version=1,
        schema_version=SCHEMA_VERSION,
    )
    for n, name, family, category, staple in [
        (2, "carrot", "carrot", "produce", False),
        (3, "frozen peas", "pea", "frozen", False),
        (4, "olive oil", "oil", "aisles", True),
        (5, "sea salt", "salt", "spices", True),
    ]
]


def _canonical(suffix: str, name: str, family: str, category: str) -> CanonicalIngredient:
    return CanonicalIngredient(
        id=f"01K7SEED0000000000000000{suffix}",
        name=name,
        family=family,
        store_category_id=category,
        confirmed=True,
        version=1,
        schema_version=SCHEMA_VERSION,
    )


# The Canonical Ingredients the Ready recipes' lines match, for a Week Plan's Grocery List. None
# shares a name with PANTRY's, which stay free, so their olive oil and carrot lines are unmatched.
ONION = _canonical("C8", "onion", "onion", "produce")
LEMON = _canonical("C9", "lemon", "lemon", "produce")
WHOLE_CHICKEN = _canonical("CA", "whole chicken", "chicken", "meat")
SALT = _canonical("CB", "salt", "salt", "spices")
TAHINI = _canonical("CC", "tahini", "sesame", "aisles")
SOY_SAUCE = _canonical("CD", "soy sauce", "soy", "aisles")
RICE_VINEGAR = _canonical("CE", "rice vinegar", "vinegar", "aisles")
CHILI_OIL = _canonical("CF", "chili oil", "oil", "aisles")
FIRM_TOFU = _canonical("CG", "firm tofu", "tofu", "produce")
CORNSTARCH = _canonical("CH", "cornstarch", "starch", "aisles")
VEGETABLE_OIL = _canonical("CJ", "vegetable oil", "oil", "aisles")
WHEAT_NOODLES = _canonical("CK", "wheat noodles", "noodle", "aisles")
GREEN_ONION = _canonical("CM", "green onion", "onion", "produce")
ROLLED_OATS = _canonical("CN", "rolled oats", "oat", "aisles")
MILK = _canonical("CP", "milk", "milk", "dairy")
YOGURT = _canonical("CQ", "plain yogurt", "yogurt", "dairy")
MAPLE_SYRUP = _canonical("CR", "maple syrup", "syrup", "aisles")
BERRIES = _canonical("CS", "berries", "berry", "produce")
RED_LENTILS = _canonical("CT", "red lentils", "lentil", "aisles")
CRUSHED_TOMATOES = _canonical("CV", "crushed tomatoes", "tomato", "aisles")
VEGETABLE_BROTH = _canonical("CW", "vegetable broth", "broth", "aisles")
CUMIN = _canonical("CX", "ground cumin", "cumin", "spices")
# FDC foods and portions in the committed FDC Snapshot that more than one line uses. Lines name
# their own food and portion inline where no other line shares them.
CHICKEN_FDC_ID = 171447  # Chicken, broilers or fryers, meat and skin, raw
LEMON_FDC_ID = 167746  # Lemons, raw, without peel
ONION_FDC_ID, ONION_MEDIUM = 170000, 85860  # Onions, raw, by the medium onion
SALT_FDC_ID, SALT_TSP = 173468, 92594  # Salt, table, by the teaspoon
GREEN_ONION_FDC_ID, GREEN_ONION_TBSP = 170006, 85883  # Onions, young green, tops only
YOGURT_FDC_ID, YOGURT_CUP = 171284, 88365  # Yogurt, plain, whole milk, by the cup
GROCERY = [
    ONION,
    LEMON,
    WHOLE_CHICKEN,
    SALT,
    TAHINI,
    SOY_SAUCE,
    RICE_VINEGAR,
    CHILI_OIL,
    FIRM_TOFU,
    CORNSTARCH,
    VEGETABLE_OIL,
    WHEAT_NOODLES,
    GREEN_ONION,
    ROLLED_OATS,
    MILK,
    YOGURT,
    MAPLE_SYRUP,
    BERRIES,
    RED_LENTILS,
    CRUSHED_TOMATOES,
    VEGETABLE_BROTH,
    CUMIN,
]


def _ingredients(*lines: str, component: str | None = None, start: int = 1) -> list[IngredientLine]:
    return [
        IngredientLine(id=f"i{start + n}", component=component, text=t) for n, t in enumerate(lines)
    ]


def _steps(*lines: str, component: str | None = None, start: int = 1) -> list[Step]:
    return [Step(id=f"s{start + n}", component=component, text=t) for n, t in enumerate(lines)]


def _website(path: str, site_name: str = "Example Kitchen") -> WebsiteSource:
    return WebsiteSource(
        url=f"https://example.com/{path}", site_name=site_name, captured_at=CAPTURED_AT
    )


def _time(text: str, seconds: int) -> StatedTime:
    return StatedTime(text=text, seconds=seconds)


def _parse(
    amount: float | tuple[float, float] | None,
    unit: str | None,
    unit_kind: Literal["mass", "volume", "count"] | None,
    name: str,
    preparation: str | None = None,
    *,
    comment: str | None = None,
    optional: bool = False,
    confirmed: bool = False,
) -> IngredientFacts:
    """A parser's reading of a line, written by hand for the seed. A pair is a range, and None no
    amount, as in "to taste".
    """
    low, high = amount if isinstance(amount, tuple) else (amount, amount)
    return IngredientFacts(
        parse=ParseFact(
            provenance="parser",
            confidence=0.9,
            estimated=False,
            confirmed=confirmed,
            confirmed_by="editor@example.com" if confirmed else None,
            confirmed_at=CAPTURED_AT if confirmed else None,
            quantity=None if low is None or high is None else Quantity(low=low, high=high),
            unit=unit,
            unit_kind=unit_kind,
            name=name,
            preparation=preparation,
            comment=comment,
            optional=optional,
        )
    )


def _editors(facts: IngredientFacts) -> IngredientFacts:
    """An Our Version line's facts as the editor gives them: Confirmed, provenance `editor`."""
    editors = {
        "provenance": "editor",
        "confidence": 1,
        "estimated": False,
        "confirmed": True,
        "confirmed_by": "editor",
        "confirmed_at": CAPTURED_AT,
    }
    parse = facts.parse.model_copy(update=editors) if facts.parse else None
    match = facts.match.model_copy(update=editors) if facts.match else None
    conversion = facts.conversion.model_copy(update=editors) if facts.conversion else None
    return IngredientFacts(parse=parse, match=match, conversion=conversion)


def _matched(
    facts: IngredientFacts,
    canonical: CanonicalIngredient,
    fdc_id: int,
    portion_id: int | None = None,
    *,
    checked: bool = True,
) -> IngredientFacts:
    """The line's facts with a match to `canonical`, and with a portion its conversion: checked
    (Confirmed, above the Confidence Threshold) or else unconfirmed and below it.
    """
    checks = {
        "confidence": 0.9 if checked else 0.6,
        "confirmed": checked,
        "confirmed_by": "editor@example.com" if checked else None,
        "confirmed_at": CAPTURED_AT if checked else None,
    }
    match = MatchFact(
        provenance="llm",
        confidence=1,
        estimated=False,
        canonical_id=canonical.id,
        fdc_id=fdc_id,
        portion_id=portion_id,
    ).model_copy(update=checks)
    conversion = facts.conversion
    if portion_id is not None:
        conversion = ConversionFact(
            provenance="fdc",
            confidence=1,
            estimated=False,
            fdc_id=fdc_id,
            **fdc.numbers(fdc.snapshot(), fdc_id, portion_id).model_dump(),
        ).model_copy(update=checks)
    return facts.model_copy(update={"match": match, "conversion": conversion})


def _ingredient(ref: str, written: str, portion: float = 1.0) -> IngredientSegment:
    return IngredientSegment(ref=ref, written=written, portion=portion)


def _duration(low_s: int, high_s: int, written: str) -> DurationSegment:
    return DurationSegment(low_s=low_s, high_s=high_s, written=written)


def _temperature(c: int, written: str) -> TemperatureSegment:
    return TemperatureSegment(c=c, written=written)


def _step_facts(*parts: str | Segment, uses: dict[str, float] | None = None) -> StepFacts:
    """A step's segments and uses, written by hand for the seed. A string is a text segment, and
    a step with no parts has no segments, so it shows its text as written.
    """
    segments = [TextSegment(v=part) if isinstance(part, str) else part for part in parts]
    return StepFacts(
        segments=SegmentsFact(provenance="llm", confidence=0.8, estimated=False, segments=segments)
        if segments
        else None,
        uses=UsesFact(
            provenance="llm",
            confidence=0.8,
            estimated=True,
            uses=[StepUse(ref=ref, portion=portion) for ref, portion in (uses or {}).items()],
        ),
    )


RECIPES = [
    Recipe(
        id=CHICKEN_ID,
        schema_version=SCHEMA_VERSION,
        version=1,
        source=_website("lemon-herb-roast-chicken"),
        dedupe_key="https://example.com/lemon-herb-roast-chicken",
        original=Original(
            title="Lemon Herb Roast Chicken",
            description="A whole chicken roasted over sliced onions with lemon and thyme.",
            author="Example Kitchen Team",
            extractor="json-ld",
            ingredients=_ingredients(
                "1 whole chicken (about 1.8 kg)",
                "2 lemons, halved",
                "6 sprigs fresh thyme",
                "2 tbsp olive oil",
                "2 onions, thickly sliced",
                "1 tsp kosher salt",
            ),
            steps=_steps(
                "Heat the oven to 425°F.",
                "Lay the onions in a roasting pan and set the chicken on top.",
                "Rub the chicken with oil and salt, and stuff it with the lemons and thyme.",
                "Roast 70-80 minutes, until the thigh reads 165°F. Rest 10 minutes before carving.",
            ),
            recipe_yield=RecipeYield(text="Serves 4", servings=4, unit="servings"),
            stated_times=StatedTimes(
                prep=_time("15 mins", 900),
                cook=_time("1 hr 20 mins", 4800),
                total=_time("1 hr 45 mins", 6300),
            ),
        ),
        tags=["Sunday", "roast"],
        difficulty=Difficulty(prep=1, cook=2, cleanup=2),
        status="ready",
        facts=RecipeFacts(
            ingredients={
                "i1": _matched(
                    _parse(
                        1, None, "count", "whole chicken", comment="about 1.8 kg", confirmed=True
                    ),
                    WHOLE_CHICKEN,
                    CHICKEN_FDC_ID,
                ),
                "i2": _matched(
                    _parse(2, None, "count", "lemons", "halved", confirmed=True),
                    LEMON,
                    LEMON_FDC_ID,
                ),
                "i3": _parse(6, "sprigs", "count", "fresh thyme", confirmed=True),
                # The olive oil is unmatched, so it is under Other.
                "i4": _parse(2, "tbsp", "volume", "olive oil", confirmed=True),
                "i5": _matched(
                    _parse(2, None, "count", "onions", "thickly sliced", confirmed=True),
                    ONION,
                    ONION_FDC_ID,
                    ONION_MEDIUM,
                ),
                "i6": _matched(
                    _parse(1, "tsp", "volume", "kosher salt", confirmed=True),
                    SALT,
                    SALT_FDC_ID,
                    SALT_TSP,
                ),
            },
            steps={
                "s1": _step_facts("Heat the oven to ", _temperature(218, "425°F"), "."),
                "s2": _step_facts(
                    "Lay ",
                    _ingredient("i5", "the onions"),
                    " in a roasting pan and set ",
                    _ingredient("i1", "the chicken"),
                    " on top.",
                    uses={"i5": 1.0, "i1": 1.0},
                ),
                "s4": _step_facts(
                    "Roast ",
                    _duration(4200, 4800, "70-80 minutes"),
                    ", until the thigh reads ",
                    _temperature(74, "165°F"),
                    ". Rest ",
                    _duration(600, 600, "10 minutes"),
                    " before carving.",
                ),
            },
        ),
        our_version=OurVersion(
            ingredients=OurLines(
                edit={"i6": OurLine(text="½ tsp kosher salt")},
                remove=["i3"],
                add=[AddedLine(id="i7", after="i2", text="4 garlic cloves, smashed")],
            ),
            facts=RecipeFacts(
                ingredients={
                    "i6": _editors(
                        _matched(
                            _parse(0.5, "tsp", "volume", "kosher salt"), SALT, SALT_FDC_ID, SALT_TSP
                        )
                    ),
                    "i7": _editors(
                        _parse(4, None, "count", "garlic cloves", "smashed").model_copy(
                            update={
                                "match": MatchFact(
                                    provenance="editor",
                                    confidence=1,
                                    estimated=False,
                                    canonical_id=GARLIC.id,
                                    fdc_id=GARLIC_FDC_ID,
                                    portion_id=GARLIC_CLOVE,
                                ),
                                "conversion": ConversionFact(
                                    provenance="editor",
                                    confidence=1,
                                    estimated=False,
                                    fdc_id=GARLIC_FDC_ID,
                                    **fdc.numbers(
                                        fdc.snapshot(), GARLIC_FDC_ID, GARLIC_CLOVE
                                    ).model_dump(),
                                ),
                            }
                        )
                    ),
                }
            ),
            steps=OurSteps(
                edit={
                    "s3": OurStep(
                        text="Rub the chicken with oil and salt, and stuff it with the lemons "
                        "and garlic."
                    )
                }
            ),
            note="Less salt, and garlic in place of the thyme.",
            edited_at=CAPTURED_AT,
        ),
        # The edited step waits for enrich to segment it.
        our_version_status="pending",
        our_version_last_line=7,
    ),
    Recipe(
        id=E2E_RECIPE_ID,
        schema_version=SCHEMA_VERSION,
        version=1,
        source=_website("sesame-noodles-crispy-tofu", "Example Noodle House"),
        dedupe_key="https://example.com/sesame-noodles-crispy-tofu",
        original=Original(
            title=E2E_RECIPE_TITLE,
            description="Cold noodles in a nutty sauce, topped with pan-fried tofu.",
            extractor="json-ld",
            ingredients=[
                *_ingredients(
                    "3 tbsp tahini",
                    "2 tbsp soy sauce",
                    "1 1/2 tbsp rice vinegar",
                    "1 tsp chili oil, or to taste",
                    component="For the sauce",
                ),
                *_ingredients(
                    "400 g firm tofu, cubed",
                    "2 tbsp cornstarch",
                    "3 tbsp neutral oil",
                    component="For the tofu",
                    start=5,
                ),
                *_ingredients(
                    "250 g wheat noodles",
                    "1-2 green onions, sliced",
                    component="For the noodles",
                    start=8,
                ),
            ],
            steps=[
                *_steps(
                    "Whisk the sauce ingredients with 2 tbsp warm water.", component="For the sauce"
                ),
                *_steps(
                    "Toss the tofu in cornstarch.",
                    "Fry in the oil over medium-high heat for 8-10 minutes, turning, until crisp.",
                    component="For the tofu",
                    start=2,
                ),
                *_steps(
                    "Cook the noodles, rinse under cold water, drain well and toss with half the "
                    "green onions.",
                    "Toss with the sauce and top with the tofu and the rest of the green onions.",
                    component="For the noodles",
                    start=4,
                ),
            ],
            recipe_yield=RecipeYield(text="4 bowls", servings=4, unit="bowls"),
            stated_times=StatedTimes(
                prep=_time("15 minutes", 900),
                cook=_time("15 minutes", 900),
                total=_time("30 minutes", 1800),
            ),
        ),
        tags=["weeknight", "vegetarian"],
        difficulty=Difficulty(prep=2, cook=2, cleanup=2),
        status="ready",
        facts=RecipeFacts(
            ingredients={
                # Confirmed, so the Adjust sheet can show it as a weight; soy sauce has none.
                "i1": _matched(
                    _parse(3, "tbsp", "volume", "tahini"), TAHINI, TAHINI_FDC_ID
                ).model_copy(
                    update={
                        "conversion": ConversionFact(
                            provenance="fdc",
                            confidence=0.9,
                            estimated=False,
                            confirmed=True,
                            confirmed_by="editor@example.com",
                            confirmed_at=CAPTURED_AT,
                            fdc_id=TAHINI_FDC_ID,
                            **fdc.numbers(fdc.snapshot(), TAHINI_FDC_ID, TAHINI_TBSP).model_dump(),
                        )
                    }
                ),
                "i2": _matched(
                    _parse(2, "tbsp", "volume", "soy sauce"), SOY_SAUCE, 174278, checked=False
                ),
                "i3": _matched(
                    _parse(1.5, "tbsp", "volume", "rice vinegar"),
                    RICE_VINEGAR,
                    172237,
                    90136,
                    checked=False,
                ),
                "i4": _matched(
                    _parse(1, "tsp", "volume", "chili oil", comment="or to taste"),
                    CHILI_OIL,
                    171016,
                    87779,
                    checked=False,
                ),
                "i5": _matched(
                    _parse(400, "g", "mass", "firm tofu", "cubed"),
                    FIRM_TOFU,
                    172475,
                    90683,
                    checked=False,
                ),
                "i6": _matched(
                    _parse(2, "tbsp", "volume", "cornstarch"),
                    CORNSTARCH,
                    169698,
                    85370,
                    checked=False,
                ),
                "i7": _matched(
                    _parse(3, "tbsp", "volume", "neutral oil"),
                    VEGETABLE_OIL,
                    172370,
                    90462,
                    checked=False,
                ),
                "i8": _matched(
                    _parse(250, "g", "mass", "wheat noodles"),
                    WHEAT_NOODLES,
                    169731,
                    85405,
                    checked=False,
                ),
                # A range, and with no portion its count has no weight.
                "i9": _matched(
                    _parse((1, 2), None, "count", "green onions", "sliced"),
                    GREEN_ONION,
                    GREEN_ONION_FDC_ID,
                    checked=False,
                ),
            },
            steps={
                # "the sauce ingredients" names no one line, so the step has no segments.
                "s1": _step_facts(uses={"i1": 1.0, "i2": 1.0, "i3": 1.0, "i4": 1.0}),
                "s2": _step_facts(
                    "Toss ",
                    _ingredient("i5", "the tofu"),
                    " in ",
                    _ingredient("i6", "cornstarch"),
                    ".",
                    uses={"i5": 1.0, "i6": 1.0},
                ),
                "s3": _step_facts(
                    "Fry in ",
                    _ingredient("i7", "the oil"),
                    " over medium-high heat for ",
                    _duration(480, 600, "8-10 minutes"),
                    ", turning, until crisp.",
                    uses={"i7": 1.0},
                ),
                "s4": _step_facts(
                    "Cook ",
                    _ingredient("i8", "the noodles"),
                    ", rinse under cold water, drain well and toss with ",
                    _ingredient("i9", "half the green onions", 0.5),
                    ".",
                    uses={"i8": 1.0, "i9": 0.5},
                ),
                "s5": _step_facts(
                    "Toss with the sauce and top with the tofu and ",
                    _ingredient("i9", "the rest of the green onions", 0.5),
                    ".",
                    uses={"i9": 0.5},
                ),
            },
        ),
        enrichment_version=1,
    ),
    Recipe(
        id="01K7SEED000000000000000003",
        schema_version=SCHEMA_VERSION,
        version=1,
        source=_website("overnight-oats", "Example Breakfasts"),
        dedupe_key="https://example.com/overnight-oats",
        original=Original(
            title="Overnight Oats",
            extractor="microdata",
            ingredients=_ingredients(
                "1/2 cup rolled oats",
                "1/2 cup milk",
                "2 oz plain yogurt",
                "1 tbsp maple syrup",
                "Berries, to serve",
            ),
            steps=_steps(
                "Stir everything but the berries together in a jar.",
                "Cover and chill overnight. Top with berries in the morning.",
            ),
            recipe_yield=RecipeYield(text="1 jar", servings=1, unit="jar"),
        ),
        tags=["breakfast"],
        difficulty=Difficulty(prep=1, cook=1, cleanup=1),
        status="ready",
        # A line in cups and one in ounces, for the Adjust sheet to show in metric.
        facts=RecipeFacts(
            ingredients={
                "i1": _matched(
                    _parse(0.5, "cup", "volume", "rolled oats", confirmed=True),
                    ROLLED_OATS,
                    2346396,
                ),
                "i2": _matched(
                    _parse(0.5, "cup", "volume", "milk", confirmed=True), MILK, 171265, 88314
                ),
                "i3": _matched(
                    _parse(2, "oz", "mass", "plain yogurt", confirmed=True),
                    YOGURT,
                    YOGURT_FDC_ID,
                    YOGURT_CUP,
                ),
                "i4": _matched(
                    _parse(1, "tbsp", "volume", "maple syrup", confirmed=True),
                    MAPLE_SYRUP,
                    169661,
                    85303,
                ),
                "i5": _matched(
                    _parse(
                        None,
                        None,
                        None,
                        "berries",
                        comment="to serve",
                        optional=True,
                        confirmed=True,
                    ),
                    BERRIES,
                    171711,
                ),
            }
        ),
    ),
    Recipe(
        id="01K7SEED000000000000000004",
        schema_version=SCHEMA_VERSION,
        version=1,
        source=_website("tomato-lentil-soup"),
        dedupe_key="https://example.com/tomato-lentil-soup",
        original=Original(
            title="Tomato Lentil Soup",
            author="Example Kitchen Team",
            extractor="json-ld",
            ingredients=_ingredients(
                "1 tbsp olive oil",
                "1 onion, diced",
                "2 carrots, diced",
                "1 cup red lentils, rinsed",
                "1 can (796 ml) crushed tomatoes",
                "4 cups vegetable broth",
                "1 tsp ground cumin",
                "1/2 cup plain yogurt, to serve",
                "2 tbsp sliced green onions",
                "Salt, to taste",
            ),
            steps=_steps(
                "Soften the onion and carrots in the oil for 5 minutes.",
                "Add the cumin, lentils, tomatoes and broth.",
                "Simmer 25 minutes, until the lentils fall apart. Blend if you like.",
                "Season with salt and serve topped with the yogurt and green onions.",
            ),
            recipe_yield=RecipeYield(text="6 servings", servings=6, unit="servings"),
            stated_times=StatedTimes(prep=_time("10 min", 600), cook=_time("30 min", 1800)),
        ),
        tags=["soup", "weeknight"],
        # No editor Difficulty, so the card and the recipe page show this one as a suggestion.
        facts=RecipeFacts(
            ingredients={
                # The olive oil and carrots are unmatched, so each is under Other.
                "i1": _parse(1, "tbsp", "volume", "olive oil", confirmed=True),
                "i2": _matched(
                    _parse(1, None, "count", "onion", "diced", confirmed=True),
                    ONION,
                    ONION_FDC_ID,
                    ONION_MEDIUM,
                ),
                "i3": _parse(2, None, "count", "carrots", "diced", confirmed=True),
                "i4": _matched(
                    _parse(1, "cup", "volume", "red lentils", "rinsed", confirmed=True),
                    RED_LENTILS,
                    174284,
                    94081,
                ),
                # A sized package: a can counts, and its size is the comment.
                "i5": _matched(
                    _parse(1, "can", "count", "crushed tomatoes", comment="796 ml", confirmed=True),
                    CRUSHED_TOMATOES,
                    170501,
                ),
                "i6": _matched(
                    _parse(4, "cup", "volume", "vegetable broth", confirmed=True),
                    VEGETABLE_BROTH,
                    171180,
                    88126,
                ),
                "i7": _matched(
                    _parse(1, "tsp", "volume", "ground cumin", confirmed=True),
                    CUMIN,
                    170923,
                    87544,
                ),
                # A volume of the yogurt Overnight Oats weighs, both conversions checked, so the
                # two become one mass.
                "i8": _matched(
                    _parse(
                        0.5, "cup", "volume", "plain yogurt", comment="to serve", confirmed=True
                    ),
                    YOGURT,
                    YOGURT_FDC_ID,
                    YOGURT_CUP,
                ),
                # A volume of the green onions the noodles count, its conversion unchecked, so the
                # two stay subtotals.
                "i9": _matched(
                    _parse(2, "tbsp", "volume", "green onions", "sliced", confirmed=True),
                    GREEN_ONION,
                    GREEN_ONION_FDC_ID,
                    GREEN_ONION_TBSP,
                    checked=False,
                ),
                # No amount: the roast chicken's salt has one, and this adds nothing to it.
                "i10": _matched(
                    _parse(None, None, None, "salt", comment="to taste", confirmed=True),
                    SALT,
                    SALT_FDC_ID,
                ),
            },
            difficulty=DifficultyFact(
                provenance="llm", confidence=0.6, estimated=True, prep=2, cook=1, cleanup=1
            ),
        ),
        status="ready",
    ),
    Recipe(
        id="01K7SEED000000000000000005",
        schema_version=SCHEMA_VERSION,
        version=1,
        source=_website("slow-simmered-beef-barley-stew"),
        dedupe_key="https://example.com/slow-simmered-beef-barley-stew",
        original=Original(
            title=(
                "Grandma-Style Slow-Simmered Beef and Barley Stew"
                " with Root Vegetables and Fresh Herbs"
            ),
            extractor="readability",
            ingredients=_ingredients(
                "900 g stewing beef, cubed",
                "2 tbsp flour",
                "2 tbsp oil",
                "1 onion, chopped",
                "3 carrots, chunked",
                "2 parsnips, chunked",
                "3/4 cup pearl barley",
                "8 cups beef stock",
                "A handful of parsley, chopped",
            ),
            steps=_steps(
                "Toss the beef in flour and brown it in the oil in batches.",
                "Add the onion and cook until soft.",
                "Add the stock and barley, cover and simmer 1 1/2 hours.",
                "Add the carrots and parsnips and simmer 45 minutes more. Finish with parsley.",
            ),
            stated_times=StatedTimes(total=_time("About 3 hours", 10800)),
        ),
        status="pending",
        ingest_channel="add_a_recipe",
    ),
    Recipe(
        id="01K7SEED000000000000000006",
        schema_version=SCHEMA_VERSION,
        version=1,
        source=SpreadsheetSource(
            url="https://sheets.example.com/d/spice-blends",
            sheet_id="spice-blends",
            entry_name="Smoky Taco Seasoning",
            captured_at=CAPTURED_AT,
        ),
        dedupe_key="spice-blends/Smoky Taco Seasoning",
        original=Original(
            title="Smoky Taco Seasoning",
            extractor="spreadsheet",
            ingredients=_ingredients(
                "3 parts chili powder",
                "2 parts smoked paprika",
                "2 parts ground cumin",
                "1 part garlic powder",
                "1 part dried oregano",
                "1/2 part cayenne",
            ),
            steps=_steps("Mix well and store in an airtight jar."),
        ),
        tags=["spice blend"],
        status="ready",
        facts=RecipeFacts(
            ingredients={
                "i1": _parse(3, "parts", "count", "chili powder", confirmed=True),
                "i2": _parse(2, "parts", "count", "smoked paprika", confirmed=True),
                "i3": _parse(2, "parts", "count", "ground cumin", confirmed=True),
                "i4": _parse(1, "part", "count", "garlic powder", confirmed=True),
                "i5": _parse(1, "part", "count", "dried oregano", confirmed=True),
                "i6": _parse(0.5, "part", "count", "cayenne", confirmed=True),
            }
        ),
    ),
    Recipe(
        id="01K7SEED000000000000000007",
        schema_version=SCHEMA_VERSION,
        version=1,
        source=_website("garlic-butter-green-beans", "Example Sides"),
        dedupe_key="https://example.com/garlic-butter-green-beans",
        original=Original(
            title="Garlic Butter Green Beans",
            extractor="json-ld",
            ingredients=_ingredients(
                "450 g green beans, trimmed",
                "2 tbsp butter",
                "3 cloves garlic, minced",
                "Salt and pepper, to taste",
            ),
            steps=_steps(
                "Blanch the beans in salted boiling water for 3 minutes, then drain.",
                "Melt the butter, add the garlic and cook 1 minute.",
                "Toss in the beans and season.",
            ),
            recipe_yield=RecipeYield(text="Serves 4 as a side", servings=4, unit="servings"),
            stated_times=StatedTimes(
                prep=_time("5 mins", 300), cook=_time("10 mins", 600), total=_time("15 mins", 900)
            ),
        ),
        tags=["side"],
        difficulty=Difficulty(prep=1, cook=1, cleanup=1),
        status="awaiting_review",
        ingest_channel="add_a_recipe",
        facts=RecipeFacts(
            ingredients={
                "i1": _parse(450, "g", "mass", "green beans", "trimmed"),
                "i2": _parse(2, "tbsp", "volume", "butter").model_copy(
                    update={
                        "match": MatchFact(
                            provenance="llm",
                            confidence=0.7,
                            estimated=False,
                            canonical_id=BUTTER.id,
                            fdc_id=BUTTER_FDC_ID,
                            portion_id=BUTTER_TBSP,
                        ),
                        "conversion": ConversionFact(
                            provenance="fdc",
                            confidence=0.8,
                            estimated=True,
                            fdc_id=BUTTER_FDC_ID,
                            **fdc.numbers(fdc.snapshot(), BUTTER_FDC_ID, BUTTER_TBSP).model_dump(),
                        ),
                        # Confirmed, so the recipe has as much to check as without it.
                        "substitutions": SubstitutionsFact(
                            provenance="llm",
                            confidence=0.7,
                            estimated=False,
                            confirmed=True,
                            confirmed_by="editor@example.com",
                            confirmed_at=CAPTURED_AT,
                            items=[
                                Substitution(
                                    wording="unsalted butter",
                                    canonical_id=UNSALTED_BUTTER.id,
                                    ratio=1,
                                    note="add a pinch more salt",
                                    fdc_id=UNSALTED_FDC_ID,
                                    portion_id=UNSALTED_TBSP,
                                    fdc=fdc.numbers(fdc.snapshot(), UNSALTED_FDC_ID, UNSALTED_TBSP),
                                )
                            ],
                        ),
                    }
                ),
                "i3": _parse(3, "cloves", "count", "garlic", "minced"),
                "i4": _parse(
                    None, None, None, "salt and pepper", comment="to taste", confirmed=True
                ),
            },
            steps={
                "s2": _step_facts(
                    "Melt ",
                    _ingredient("i2", "the butter"),
                    ", add ",
                    _ingredient("i3", "the garlic"),
                    " and cook ",
                    _duration(60, 60, "1 minute"),
                    ".",
                    uses={"i2": 1.0, "i3": 1.0},
                ),
            },
        ),
        issues=[
            EnrichmentIssue(
                id="01K7SEED0000000000000000D1",
                fact_id="i2.match",
                before="margarine",
                after="butter",
                reason="The line says butter, so it is a new Canonical Ingredient, not margarine.",
                model="seed",
            )
        ],
        enrichment_version=1,
    ),
]


# The seeded recipes with a photo, by id: its colour and its focal point. The rest have none.
PHOTOS = {
    "01K7SEED000000000000000001": ("#C8743A", (0.5, 0.5)),
    E2E_RECIPE_ID: ("#B5543C", (0.3, 0.4)),
    "01K7SEED000000000000000003": ("#8E6FB0", (0.7, 0.3)),
    "01K7SEED000000000000000004": ("#C2452D", (0.5, 0.75)),
    "01K7SEED000000000000000007": ("#4F8A4A", (0.25, 0.6)),
}


FAVORITE_SITES = [
    FavoriteSite(
        id="01K7SEED0000000000000000F1",
        name="Example Kitchen",
        address="https://www.example.com/",
        note="Weeknight dinners that hold up.",
    ),
    FavoriteSite(
        id="01K7SEED0000000000000000F2",
        name="Example Bakes",
        address="https://example.org/bread",
        note="",
    ),
]


def placeholder_photo(
    colour: str, focal: tuple[float, float] = (0.5, 0.5), width: int = 1200, height: int = 800
) -> bytes:
    """A generated placeholder photo as PNG: a pale plate on `colour`, centred on `focal`."""
    image = Image.new("RGB", (width, height), colour)
    x, y, r = focal[0] * width, focal[1] * height, min(width, height) // 3
    draw = ImageDraw.Draw(image)
    draw.ellipse((x - r, y - r, x + r, y + r), fill="#F4EFE6", outline="#FFFFFF", width=12)
    draw.ellipse((x - r // 2, y - r // 2, x + r // 2, y + r // 2), fill=colour)
    out = io.BytesIO()
    image.save(out, "PNG")
    return out.getvalue()


def load(store: Store, images: ImageStore) -> None:
    for recipe in RECIPES:
        added = store.add_recipe(_with_photo(recipe, images) if recipe.id in PHOTOS else recipe)
        if added.id == CHICKEN_ID:
            store.enrich_recipe(added, [GARLIC, *GROCERY], [GARLIC_WORDING])
        if added.id == REVIEW_RECIPE_ID:
            store.enrich_recipe(added, [BUTTER, UNSALTED_BUTTER, *PANTRY], [BUTTER_WORDING])
    store.save_favorite_sites(store.favorite_sites().model_copy(update={"sites": FAVORITE_SITES}))


def _with_photo(recipe: Recipe, images: ImageStore) -> Recipe:
    colour, (focal_x, focal_y) = PHOTOS[recipe.id]
    origin = f"https://example.com/photos/{recipe.id.lower()}.png"
    image = images.put(placeholder_photo(colour, (focal_x, focal_y)), origin=origin)
    preview = Preview(image_id=image.id, focal_x=focal_x, focal_y=focal_y)
    return recipe.model_copy(update={"images": [image], "preview": preview})
