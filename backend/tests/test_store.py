import pytest

from recipes.models import StatedTime, StatedTimes, card_for
from recipes.seed import RECIPES
from recipes.store import DuplicateSource, Store, VersionConflict

TWENTY_MINUTES = StatedTime(text="20 mins", seconds=1200)
HALF_AN_HOUR = StatedTime(text="30 minutes", seconds=1800)
AN_HOUR = StatedTime(text="1 hour", seconds=3600)
OVERNIGHT = StatedTime(text="overnight", seconds=None)


def test_card_upkeep_copies_the_recipes_card_fields() -> None:
    recipe = RECIPES[0].model_copy(update={"version": 4})

    card = card_for(recipe)

    assert card.id == recipe.id
    assert card.schema_version == recipe.schema_version
    assert card.title == recipe.original.title
    assert card.site_name == "Example Kitchen"
    assert card.difficulty == recipe.difficulty
    assert card.tags == recipe.tags
    assert card.status == recipe.status
    assert card.preview == recipe.preview
    assert card.recipe_version == 4
    assert card.needs_review.open_issues == 0
    assert card.needs_review.unconfirmed == 0


@pytest.mark.parametrize(
    ("times", "stated_seconds"),
    [
        (StatedTimes(prep=TWENTY_MINUTES, cook=HALF_AN_HOUR, total=AN_HOUR), 3600),
        (StatedTimes(prep=TWENTY_MINUTES, cook=HALF_AN_HOUR), 3000),
        (StatedTimes(prep=TWENTY_MINUTES), None),
        (StatedTimes(), None),
        (StatedTimes(prep=AN_HOUR, cook=AN_HOUR, total=OVERNIGHT), 7200),
    ],
)
def test_card_upkeep_states_the_total_time_or_else_prep_plus_cook(
    times: StatedTimes, stated_seconds: int | None
) -> None:
    original = RECIPES[0].original.model_copy(update={"stated_times": times})
    recipe = RECIPES[0].model_copy(update={"original": original})

    assert card_for(recipe).stated_seconds == stated_seconds


def test_adding_a_recipe_writes_its_card_and_bumps_the_collection(store: Store) -> None:
    before = store.collection_version()

    added = store.add_recipe(RECIPES[0])

    assert added.version == 1
    assert store.get_recipe(added.id) == added
    assert store.cards() == [card_for(added)]
    assert store.collection_version() == before + 1


def test_updating_a_recipe_bumps_its_version_its_card_and_the_collection(store: Store) -> None:
    added = store.add_recipe(RECIPES[0])
    before = store.collection_version()

    updated = store.update_recipe(added.model_copy(update={"tags": ["roast", "sunday"]}))

    assert updated.version == 2
    assert store.get_recipe(added.id) == updated
    assert store.cards() == [card_for(updated)]
    assert store.cards()[0].tags == ["roast", "sunday"]
    assert store.collection_version() == before + 1


def test_a_stale_recipe_version_is_refused(store: Store) -> None:
    added = store.add_recipe(RECIPES[0])
    current = store.update_recipe(added)
    before = store.collection_version()

    with pytest.raises(VersionConflict):
        store.update_recipe(added.model_copy(update={"tags": ["stale"]}))

    assert store.get_recipe(added.id) == current
    assert store.collection_version() == before


def test_a_source_cannot_be_added_twice(store: Store) -> None:
    store.add_recipe(RECIPES[0])
    before = store.collection_version()
    again = RECIPES[1].model_copy(update={"dedupe_key": RECIPES[0].dedupe_key})

    with pytest.raises(DuplicateSource):
        store.add_recipe(again)

    assert store.get_recipe(again.id) is None
    assert [card.id for card in store.cards()] == [RECIPES[0].id]
    assert store.collection_version() == before


def test_saving_kitchen_settings_bumps_their_version_and_the_collection(store: Store) -> None:
    settings = store.kitchen_settings()
    before = store.collection_version()
    renamed = settings.store_categories[0].model_copy(update={"name": "Home"})

    saved = store.save_kitchen_settings(
        settings.model_copy(update={"store_categories": [renamed, *settings.store_categories[1:]]})
    )

    assert saved.version == settings.version + 1
    assert store.kitchen_settings() == saved
    assert store.collection_version() == before + 1
    with pytest.raises(VersionConflict):
        store.save_kitchen_settings(settings)


def test_cards_are_read_across_every_page(store: Store) -> None:
    for recipe in RECIPES:
        store.add_recipe(recipe)

    assert [card.id for card in store.cards(page_size=2)] == sorted(r.id for r in RECIPES)


def test_numbers_survive_the_round_trip(store: Store) -> None:
    preview = {"image_id": "abc123", "focal_x": 0.25, "focal_y": 0.5}
    recipe = RECIPES[0].model_validate(RECIPES[0].model_dump() | {"preview": preview})

    added = store.add_recipe(recipe)

    assert store.get_recipe(added.id) == added
    assert store.cards()[0].preview == added.preview
