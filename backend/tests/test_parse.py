"""Reading an ingredient line into its parse fact: quantity, unit, name and preparation."""

import pytest

from recipes.parse import parse_line


@pytest.mark.parametrize(
    ("line", "low", "high"),
    [
        ("1-2 tbsp olive oil", 1, 2),
        ("1 to 2 cups flour", 1, 2),
        ("2-3 cloves garlic", 2, 3),
        ("1 1/2 cups milk", 1.5, 1.5),
        ("½ cup sugar", 0.5, 0.5),
        ("1½ cups water", 1.5, 1.5),
        ("1 ½ cups rice", 1.5, 1.5),
        ("900 g stewing beef, cubed", 900, 900),
        ("1 lb 8 oz pork shoulder", 1.5, 1.5),
    ],
)
def test_a_quantity_is_a_range_equal_at_both_ends_for_one_value(
    line: str, low: float, high: float
) -> None:
    quantity = parse_line(line).quantity

    assert quantity is not None
    assert (quantity.low, quantity.high) == (low, high)


@pytest.mark.parametrize("line", ["salt, to taste", "Berries, to serve", "olive oil, for frying"])
def test_a_line_without_an_amount_has_no_quantity_unit_or_kind(line: str) -> None:
    fact = parse_line(line)

    assert (fact.quantity, fact.unit, fact.unit_kind) == (None, None, None)


def test_an_amount_with_or_to_taste_keeps_its_amount() -> None:
    fact = parse_line("1 tsp chili oil, or to taste")

    assert fact.quantity is not None
    assert (fact.quantity.low, fact.unit, fact.unit_kind) == (1, "teaspoon", "volume")
    assert fact.name == "chili oil"


@pytest.mark.parametrize(
    ("line", "unit", "kind"),
    [
        ("900 g stewing beef, cubed", "gram", "mass"),
        ("2 1/2 lbs chicken thighs", "pound", "mass"),
        ("1-2 tbsp olive oil", "tablespoon", "volume"),
        ("½ cup sugar", "cup", "volume"),
        ("2 eggs", None, "count"),
        ("3 cloves garlic, minced", "cloves", "count"),
        # The first of several amounts: the can, not the volume it holds.
        ("1 can (796 ml) diced tomatoes", "can", "count"),
    ],
)
def test_the_unit_kind_comes_from_the_units_dimension(
    line: str, unit: str | None, kind: str
) -> None:
    fact = parse_line(line)

    assert (fact.unit, fact.unit_kind) == (unit, kind)


def test_the_name_and_preparation_come_from_the_parser() -> None:
    fact = parse_line("900 g stewing beef, cubed")

    assert (fact.name, fact.preparation) == ("stewing beef", "cubed")
    assert parse_line("2 eggs").preparation is None


@pytest.mark.parametrize(
    "line",
    ["1/4 cup cilantro (optional)", "2 tbsp parsley, chopped, for garnish", "Berries, to serve"],
)
def test_optional_garnish_and_to_serve_lines_are_optional(line: str) -> None:
    assert parse_line(line).optional


@pytest.mark.parametrize("line", ["salt, to taste", "2 eggs"])
def test_other_lines_are_not_optional(line: str) -> None:
    assert not parse_line(line).optional


def test_the_fact_is_the_parsers_unconfirmed_and_not_estimated() -> None:
    fact = parse_line("2 tbsp parsley, chopped, for garnish")

    assert (fact.provenance, fact.estimated, fact.confirmed) == ("parser", False, False)
    assert (fact.confirmed_by, fact.confirmed_at, fact.short_name) == (None, None, None)
    assert 0 < fact.confidence <= 1


def test_a_line_the_parser_is_unsure_of_has_lower_confidence() -> None:
    sure = parse_line("1 1/2 cups milk").confidence
    unsure = parse_line("1 can (796 ml) diced tomatoes").confidence

    assert unsure < 0.9 < sure
