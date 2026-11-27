"""The synthetic seed gives a Week Plan's Grocery List something real to combine."""

from typing import TYPE_CHECKING

from recipes import fdc
from recipes.models import effective
from recipes.seed import GROCERY, RECIPES, load

if TYPE_CHECKING:
    from recipes.images import ImageStore
    from recipes.store import Store


def test_every_ready_lines_match_is_a_seeded_canonical_and_its_conversion_fits(
    store: Store, images: ImageStore
) -> None:
    load(store, images)
    canonicals = {canonical.id: canonical for canonical in store.canonical_ingredients()}

    matched: dict[str, int] = {}
    for recipe in store.recipes():
        if recipe.status != "ready":
            continue
        facts = effective(recipe).facts.ingredients
        for line_id, line in facts.items():
            if line.match is None:
                continue
            assert line.match.canonical_id in canonicals, (recipe.id, line_id)
            matched[line.match.canonical_id] = matched.get(line.match.canonical_id, 0) + 1
            parse, conversion = line.parse, line.conversion
            # Enrichment's conversions, not an editor's pick, which this doesn't check.
            if conversion is None or conversion.provenance != "fdc":
                continue
            assert parse is not None
            assert parse.unit_kind is not None
            found = fdc.Conversion.model_validate(
                conversion.model_dump(include=set(fdc.Conversion.model_fields))
            )
            assert fdc.fits(found, parse.unit_kind, parse.unit), (recipe.id, line_id)

    assert {canonical.id for canonical in GROCERY} <= matched.keys()
    assert len({canonicals[i].store_category_id for i in matched}) >= 4
    shared = [i for i, count in matched.items() if count > 1]
    assert {canonicals[i].name for i in shared} >= {"onion", "plain yogurt", "green onion", "salt"}
    assert any(recipe.status != "ready" for recipe in RECIPES), "for the not-Ready banner"
