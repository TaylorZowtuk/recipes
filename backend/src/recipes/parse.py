"""The deterministic part of enrichment: an ingredient line read into its parse fact."""

import re
from fractions import Fraction
from typing import Literal, cast

from ingredient_parser import parse_ingredient
from ingredient_parser.dataclasses import CompositeIngredientAmount, IngredientAmount
from pint import Unit

from recipes.models import ParseFact, Quantity

OPTIONAL = re.compile(r"\boptional\b|\bgarnish\b|\bto serve\b", re.IGNORECASE)


def parse_line(text: str) -> ParseFact:
    """The parser's reading of one line. Its confidence is the lowest of the parser's own
    confidences in the parts it filled: the name, the amount and the preparation.
    """
    parsed = parse_ingredient(text, separate_names=False)
    # A line can state several amounts, as "1 can (796 ml)" does. The first is the one the line
    # counts in, so it's kept; amounts the parser couldn't read as a number ("1 dozen") are skipped.
    amount = next((read for a in parsed.amount if (read := _amount(a))), None)
    confidences = [name.confidence for name in parsed.name]
    if parsed.preparation:
        confidences.append(parsed.preparation.confidence)
    quantity, unit, unit_kind = None, None, None
    if amount:
        quantity, written, confidence = amount
        unit, unit_kind = str(written) or None, _kind(written)  # "2 eggs" has no unit
        confidences.append(confidence)
    return ParseFact(
        provenance="parser",
        confidence=min(confidences, default=0),
        estimated=False,
        quantity=quantity,
        unit=unit,
        unit_kind=unit_kind,
        name=" ".join(name.text for name in parsed.name) or text,
        preparation=parsed.preparation.text if parsed.preparation else None,
        optional=bool(OPTIONAL.search(text)),
    )


def _amount(
    amount: IngredientAmount | CompositeIngredientAmount,
) -> tuple[Quantity, Unit | str, float] | None:
    """An amount's quantity, unit and confidence, if its quantity is a number."""
    if isinstance(amount, CompositeIngredientAmount):  # "1 lb 2 oz", as one amount in one unit
        combined = amount.combined()
        value = cast("float", combined.m_as(combined.units))
        return Quantity(low=value, high=value), combined.units, amount.confidence
    if not isinstance(amount.quantity, Fraction):
        return None
    quantity = Quantity(low=float(amount.quantity), high=float(amount.quantity_max))
    return quantity, amount.unit, amount.confidence


def _kind(unit: Unit | str) -> Literal["mass", "volume", "count"]:
    """Mass or volume by the unit's dimension, and otherwise a count: "2 eggs", "1 can"."""
    if isinstance(unit, Unit):
        if unit.is_compatible_with("gram"):
            return "mass"
        if unit.is_compatible_with("liter"):
            return "volume"
    return "count"
