"""A synthetic Collection for `make dev` and the end-to-end tests, written for this repo.

`load` adds it through the store, so the cards and `META#collection` come from card upkeep,
giving the recipes in PHOTOS a generated placeholder photo. The end-to-end tests rely on
E2E_RECIPE_ID and E2E_RECIPE_TITLE: a Ready recipe with components, whose slug is
"sesame-noodles-with-crispy-tofu".
"""

import io
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from PIL import Image, ImageDraw

from recipes.models import (
    SCHEMA_VERSION,
    Difficulty,
    IngredientLine,
    Original,
    Preview,
    Recipe,
    RecipeYield,
    SpreadsheetSource,
    StatedTime,
    StatedTimes,
    Step,
    WebsiteSource,
)

if TYPE_CHECKING:
    from recipes.images import ImageStore
    from recipes.store import Store

CAPTURED_AT = datetime(2026, 9, 1, 12, tzinfo=UTC)

E2E_RECIPE_ID = "01K7SEED000000000000000002"
E2E_RECIPE_TITLE = "Sesame Noodles with Crispy Tofu"


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


RECIPES = [
    Recipe(
        id="01K7SEED000000000000000001",
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
                    "1 tbsp rice vinegar",
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
                    "2 green onions, sliced",
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
                    "Cook the noodles, rinse under cold water and drain well.",
                    "Toss with the sauce and top with the tofu and green onions.",
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
                "1/4 cup plain yogurt",
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
            ),
            steps=_steps(
                "Soften the onion and carrots in the oil for 5 minutes.",
                "Add the cumin, lentils, tomatoes and broth.",
                "Simmer 25 minutes, until the lentils fall apart. Blend if you like.",
            ),
            recipe_yield=RecipeYield(text="6 servings", servings=6, unit="servings"),
            stated_times=StatedTimes(prep=_time("10 min", 600), cook=_time("30 min", 1800)),
        ),
        tags=["soup", "weeknight"],
        status="awaiting_review",
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
        store.add_recipe(_with_photo(recipe, images) if recipe.id in PHOTOS else recipe)


def _with_photo(recipe: Recipe, images: ImageStore) -> Recipe:
    colour, (focal_x, focal_y) = PHOTOS[recipe.id]
    origin = f"https://example.com/photos/{recipe.id.lower()}.png"
    image = images.put(placeholder_photo(colour, (focal_x, focal_y)), origin=origin)
    preview = Preview(image_id=image.id, focal_x=focal_x, focal_y=focal_y)
    return recipe.model_copy(update={"images": [image], "preview": preview})
