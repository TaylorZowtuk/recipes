"""The FDC Snapshot: USDA FoodData Central's Foundation Foods and SR Legacy, trimmed to what
enrichment uses, pinned and committed under backend/fdc, outside the Lambda zip.

`python -m recipes.fdc build` downloads both pinned releases, checks their sha256 and writes the
snapshot. The same downloads always give the same bytes.
"""

import argparse
import csv
import gzip
import hashlib
import io
import json
import re
import tempfile
import zipfile
from fractions import Fraction
from functools import cache
from pathlib import Path
from typing import TYPE_CHECKING, NamedTuple, cast

import requests
from pint import UnitRegistry
from pydantic import BaseModel, ConfigDict, PrivateAttr

from recipes.models import Dataset, Per100g

if TYPE_CHECKING:
    from collections.abc import Iterator


class Source(NamedTuple):
    url: str
    sha256: str


FOUNDATION_DATE = "2026-04-30"
SOURCES: dict[Dataset, Source] = {
    "foundation": Source(
        f"https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_csv_{FOUNDATION_DATE}.zip",
        "70457ee9d9342f43bda2010318c85f04210c689fdeb9cd2da4c513b0e8dbc655",
    ),
    "sr_legacy": Source(
        "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip",
        "b80817294b8850530aaedf2e515c02593b1824f763a0ff356e5c2081643e6fd0",
    ),
}
RELEASE = f"foundation-{FOUNDATION_DATE}+sr_legacy-2018-04"
DEFAULT_PATH = Path(__file__).resolve().parents[2] / "fdc" / f"{RELEASE}.json.gz"

# Energy is Atwater's specific factors (2048) or general ones (2047) where the food has no 1008.
KCAL = ("1008", "2048", "2047")
UNDETERMINED = "undetermined"

# A portion's unit, as FDC writes it, and pint's name for it.
VOLUMES = {
    "cup": "cup",
    "cups": "cup",
    "tablespoon": "tablespoon",
    "tablespoons": "tablespoon",
    "tbsp": "tablespoon",
    "teaspoon": "teaspoon",
    "teaspoons": "teaspoon",
    "tsp": "teaspoon",
    "fl oz": "fluid_ounce",
    "pint": "pint",
    "quart": "quart",
    "gallon": "gallon",
    "liter": "liter",
    "milliliter": "milliliter",
    "ml": "milliliter",
    "cubic inch": "cubic_inch",
    "cubic centimeter": "cubic_centimeter",
    "cc": "cubic_centimeter",
}
MASSES = ("oz", "ounce", "ounces", "lb", "lbs", "pound", "pounds", "g", "gram", "grams", "kg")
# Units that are neither: a serving size, FDC's yield weights ("paired cooked w"), or none at all.
NOT_COUNTS = (
    *("serving", "servings", "nlea", "racc", "portion", "recipe"),
    *("paired", "orig", "dripping", UNDETERMINED),
)
# Count units that say nothing on their own, so a size in the modifier ("large") names the count.
GENERIC_COUNTS = ("each", "piece", "unit", "item")
WORDS = re.compile(r"[a-z]+")
PHRASE = re.compile(r"[a-z]+(?: [a-z]+)*")
# Plurals, enough to match "berries" with "berry" and "eggs" with "egg", but not "glass".
PLURAL_IES = re.compile(r"(?<=..)ies$")
PLURAL_S = re.compile(r"(?<=...)(?<!s)s$")


class Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class Portion(Frozen):
    """One of a food's portions: `amount` of `unit` weighs `gram_weight`. SR Legacy writes its
    unit out in the modifier ("cup, chopped"), which becomes the unit.
    """

    id: int
    amount: float
    unit: str
    modifier: str | None
    gram_weight: float


class Food(Frozen):
    fdc_id: int
    dataset: Dataset
    description: str
    per_100g: Per100g
    portions: tuple[Portion, ...]


class Conversion(Frozen):
    """What a food's portion converts: a density for a volume, grams per count for a count, or why
    it converts nothing.
    """

    density_g_per_ml: float | None = None
    grams_per_count: float | None = None
    count_unit: str | None = None
    refused: str | None = None


class Snapshot(Frozen):
    release: str
    foods: tuple[Food, ...]
    _by_id: dict[int, Food] = PrivateAttr()
    # Each food's words, and the words of its description's first part ("Egg" in "Egg, whole").
    _tokens: list[tuple[Food, frozenset[str], frozenset[str]]] = PrivateAttr()

    def model_post_init(self, _context: object, /) -> None:
        self._by_id = {food.fdc_id: food for food in self.foods}
        self._tokens = [
            (food, words(food.description), words(food.description.split(",")[0]))
            for food in self.foods
        ]

    def food(self, fdc_id: int) -> Food:
        """The food with this FDC id. KeyError if the FDC Snapshot has none."""
        return self._by_id[fdc_id]

    def candidates(self, name: str, limit: int) -> list[Food]:
        """The foods whose descriptions share words with an ingredient's name, best first: those
        whose description starts with the name ("Egg, whole" for "egg", before "Bread, egg"), then
        by the share of their words in common, then Foundation before SR Legacy, then by FDC id.
        """
        wanted = words(name)
        scored = [
            (head != wanted, -Fraction(len(wanted & tokens), len(wanted | tokens)), food)
            for food, tokens, head in self._tokens
            if wanted & tokens
        ]
        scored.sort(key=lambda s: (s[0], s[1], s[2].dataset != "foundation", s[2].fdc_id))
        return [food for _, _, food in scored[:limit]]


def words(text: str) -> frozenset[str]:
    """A text's words, lowercase and singular enough to match ("berries" and "berry")."""
    return frozenset(_singular(word) for word in WORDS.findall(text.lower()))


def _singular(word: str) -> str:
    return PLURAL_S.sub("", PLURAL_IES.sub("y", word))


def convert(food: Food, portion_id: int | None) -> Conversion:
    """The conversion a food's chosen portion gives."""
    if portion_id is None:
        return Conversion(refused="no portion chosen")
    portion = next((p for p in food.portions if p.id == portion_id), None)
    if portion is None:
        return Conversion(refused=f"portion {portion_id} is not one of food {food.fdc_id}'s")
    if portion.amount <= 0:
        return Conversion(refused="the portion has no amount")
    if portion.gram_weight <= 0:
        return Conversion(refused="the portion has no weight")
    unit = _phrase(portion.unit)
    if volume := _starts_with(unit, VOLUMES):
        ml = _ml_per(VOLUMES[volume]) * portion.amount
        return Conversion(density_g_per_ml=portion.gram_weight / ml)
    if mass := _starts_with(unit, MASSES):
        return Conversion(refused=f"{mass} is a mass, which gives no conversion")
    if not unit or unit.split()[0] in NOT_COUNTS:
        return Conversion(refused=f"{unit or 'no unit'} is neither a volume nor a count")
    if unit in GENERIC_COUNTS and (size := _phrase(portion.modifier or "")):
        unit = size
    return Conversion(grams_per_count=portion.gram_weight / portion.amount, count_unit=unit)


def _phrase(text: str) -> str:
    """The words a unit or modifier starts with, before any comma, bracket or number: "cup" in
    "cup, chopped", "large" in 'large (about 6-1/2" dia)'.
    """
    match = PHRASE.match(text.strip().lower())
    return match[0] if match else ""


def _starts_with(phrase: str, units: tuple[str, ...] | dict[str, str]) -> str | None:
    """The unit a phrase starts with, as a whole word or words."""
    return next((u for u in units if phrase == u or phrase.startswith(f"{u} ")), None)


@cache
def _ml_per(unit: str) -> float:
    return cast("float", UnitRegistry().Quantity(1, unit).m_as("milliliter"))


def load_snapshot(path: Path = DEFAULT_PATH) -> Snapshot:
    """A snapshot from its file, gzipped or not."""
    data = path.read_bytes()
    return Snapshot.model_validate_json(gzip.decompress(data) if path.suffix == ".gz" else data)


def write_snapshot(snapshot: Snapshot, directory: Path) -> Path:
    """Write `<release>.json.gz` into a directory: sorted keys and no timestamp, so the same
    snapshot is the same bytes.
    """
    data = json.dumps(
        snapshot.model_dump(mode="json"), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{snapshot.release}.json.gz"
    path.write_bytes(gzip.compress(data.encode(), compresslevel=9, mtime=0))
    return path


def trim(foundation: Path, sr_legacy: Path, release: str) -> Snapshot:
    """The snapshot of two FDC CSV zips: every food of each dataset, with the fields we use."""
    foods = [*_foods(foundation, "foundation"), *_foods(sr_legacy, "sr_legacy")]
    return Snapshot(release=release, foods=tuple(sorted(foods, key=lambda food: food.fdc_id)))


def _foods(path: Path, dataset: Dataset) -> Iterator[Food]:
    data_type = {"foundation": "foundation_food", "sr_legacy": "sr_legacy_food"}[dataset]
    with zipfile.ZipFile(path) as zf:
        descriptions = {
            row["fdc_id"]: row["description"].strip()
            for row in _rows(zf, "food.csv")
            if row["data_type"] == data_type
        }
        # Ids stay as written: a few portions belong to no food at all, and match none.
        nutrients: dict[str, dict[str, float]] = {}
        for row in _rows(zf, "food_nutrient.csv"):
            fdc_id = row["fdc_id"]
            if fdc_id in descriptions and row["amount"]:
                nutrients.setdefault(fdc_id, {})[row["nutrient_id"]] = float(row["amount"])
        units = {row["id"]: row["name"] for row in _rows(zf, "measure_unit.csv")}
        portions: dict[str, list[Portion]] = {}
        for row in _rows(zf, "food_portion.csv"):
            fdc_id = row["fdc_id"]
            if fdc_id in descriptions:
                portions.setdefault(fdc_id, []).append(_portion(row, units))
    for fdc_id, description in descriptions.items():
        amounts = nutrients.get(fdc_id, {})
        yield Food(
            fdc_id=int(fdc_id),
            dataset=dataset,
            description=description,
            per_100g=Per100g(
                kcal=next((amounts[n] for n in KCAL if n in amounts), None),
                protein_g=amounts.get("1003"),
                fat_g=amounts.get("1004"),
                carbs_g=amounts.get("1005"),
                sodium_mg=amounts.get("1093"),
            ),
            portions=tuple(sorted(portions.get(fdc_id, []), key=lambda p: p.id)),
        )


def _portion(row: dict[str, str], units: dict[str, str]) -> Portion:
    unit = units.get(row["measure_unit_id"], UNDETERMINED)
    modifier = row["modifier"].strip() or None
    if unit == UNDETERMINED and modifier:
        unit, modifier = modifier, None
    return Portion(
        id=int(row["id"]),
        amount=float(row["amount"] or 0),
        unit=unit,
        modifier=modifier,
        gram_weight=float(row["gram_weight"] or 0),
    )


def _rows(zf: zipfile.ZipFile, name: str) -> Iterator[dict[str, str]]:
    """The rows of the zip's CSV of this name, which FDC keeps in a folder named for the release."""
    member = next(n for n in zf.namelist() if n.endswith(f"/{name}"))
    with zf.open(member) as raw:
        yield from csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))


def _download(source: Source, path: Path) -> Path:
    response = requests.get(source.url, timeout=120)
    response.raise_for_status()
    digest = hashlib.sha256(response.content).hexdigest()
    if digest != source.sha256:
        msg = f"{source.url} has sha256 {digest}, not the pinned {source.sha256}"
        raise SystemExit(msg)
    path.write_bytes(response.content)
    return path


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m recipes.fdc", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser(
        "build", help="download the pinned releases, write the FDC Snapshot"
    )
    build.add_argument("--out", type=Path, default=DEFAULT_PATH.parent)
    args = parser.parse_args(argv)
    with tempfile.TemporaryDirectory() as tmp:
        zips = {
            name: _download(source, Path(tmp) / f"{name}.zip") for name, source in SOURCES.items()
        }
        snapshot = trim(zips["foundation"], zips["sr_legacy"], RELEASE)
    path = write_snapshot(snapshot, cast("Path", args.out))
    print(f"{path}: {len(snapshot.foods)} foods, {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
