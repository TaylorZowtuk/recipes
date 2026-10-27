"""The deterministic part of enrichment: an ingredient line read into its parse fact."""

import re
from fractions import Fraction
from typing import Literal, cast

from ingredient_parser import parse_ingredient
from ingredient_parser.dataclasses import CompositeIngredientAmount, IngredientAmount
from pint import Unit

from recipes.models import MAX_LABEL, ParseFact, Quantity

OPTIONAL = re.compile(r"\boptional\b|\bgarnish\b|\bto serve\b", re.IGNORECASE)
# Pint's short symbols, except where a kitchen writes it otherwise. Pint reads each back.
SHORT_UNITS = {"cp": "cup"}
# The parser leaves "2 dozen" as text, writing "1 1/2" as "1#1$2" and "a dozen" as "dozen".
DOZEN = re.compile(r"^(?P<low>[\d#$./]*)(?:-(?P<high>[\d#$./]+))?\s*dozen$")
DOZEN_WORD = re.compile(r"\bdozen\b", re.IGNORECASE)
# The most confidence a line can have when one of its amounts isn't a number ("a few sprigs"),
# so an editor reviews it.
UNREAD_AMOUNT_CONFIDENCE = 0.5


def parse_line(text: str) -> ParseFact:
    """The parser's reading of one line. Its confidence is the lowest of the parser's own
    confidences in the parts it filled: the name, the amount, the preparation and the remarks.
    """
    # The parser keeps "N dozen" as an amount only when "dozen" is lowercase.
    parsed = parse_ingredient(DOZEN_WORD.sub("dozen", text), separate_names=False)
    # A line can state several amounts, as "1 can (796 ml)" does. The first one read as a number is
    # the one the line counts in. Any amount that isn't a number is kept as written in the remarks.
    read = [(a, _amount(a)) for a in parsed.amount]
    amount = next((amount for _, amount in read if amount), None)
    unread = [a.text for a, amount in read if not amount]
    confidences = [name.confidence for name in parsed.name]
    if parsed.preparation:
        confidences.append(parsed.preparation.confidence)
    # The line's remarks are the parser's comment, unbracketed, then its purpose ("for frying").
    remarks = [part for part in (parsed.comment, parsed.purpose) if part]
    confidences.extend(part.confidence for part in remarks)
    comment = ", ".join(
        [part.text.removeprefix("(").removesuffix(")") for part in remarks] + unread
    )
    if unread:
        confidences.append(UNREAD_AMOUNT_CONFIDENCE)
    quantity, unit, unit_kind = None, None, None
    if amount:
        quantity, written, confidence = amount
        unit, unit_kind = _short(written), _kind(written)
        confidences.append(confidence)
    return ParseFact(
        provenance="parser",
        confidence=min(confidences, default=0),
        estimated=False,
        quantity=quantity,
        unit=unit,
        unit_kind=unit_kind,
        name=_label(" ".join(name.text for name in parsed.name) or text),
        preparation=_label(parsed.preparation.text) if parsed.preparation else None,
        comment=_label(comment) or None,
        optional=bool(OPTIONAL.search(text)),
    )


def _label(text: str) -> str:
    """Text cut to a label's limit, ending in an ellipsis when it was cut."""
    if len(text) <= MAX_LABEL:
        return text
    return text[: MAX_LABEL - 1].rstrip() + "…"


def _amount(
    amount: IngredientAmount | CompositeIngredientAmount,
) -> tuple[Quantity, Unit | str, float] | None:
    """An amount's quantity, unit and confidence, if its quantity is a number."""
    if isinstance(amount, CompositeIngredientAmount):  # "1 lb 2 oz", as one amount in one unit
        combined = amount.combined()
        value = cast("float", combined.m_as(combined.units))
        return Quantity(low=value, high=value), combined.units, amount.confidence
    if isinstance(amount.quantity, Fraction):
        quantity = Quantity(low=float(amount.quantity), high=float(amount.quantity_max))
        return quantity, amount.unit, amount.confidence
    if dozen := DOZEN.match(amount.quantity):
        low = _number(dozen["low"]) * 12
        high = _number(dozen["high"]) * 12 if dozen["high"] else low
        return Quantity(low=float(low), high=float(high)), "", amount.confidence
    return None


def _number(text: str) -> Fraction:
    """The parser's written number ("2", "1#1$2" for 1½), and 1 when there is none ("a dozen")."""
    parts = text.replace("#", " ").replace("$", "/").split()
    return sum((Fraction(part) for part in parts), Fraction(0)) or Fraction(1)


def _short(unit: Unit | str) -> str | None:
    """A unit pint knows as its short symbol ("tbsp", "g"), and any other as written ("cloves").
    "2 eggs" has no unit.
    """
    if isinstance(unit, str):
        return unit or None
    symbol = f"{unit:~}"
    return SHORT_UNITS.get(symbol, symbol)


def _kind(unit: Unit | str) -> Literal["mass", "volume", "count"]:
    """Mass or volume by the unit's dimension, and otherwise a count: "2 eggs", "1 can"."""
    if isinstance(unit, Unit):
        if unit.is_compatible_with("gram"):
            return "mass"
        if unit.is_compatible_with("liter"):
            return "volume"
    return "count"
