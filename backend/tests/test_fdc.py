"""The FDC snapshot: finding a line's candidate foods and converting through a food's portion."""

import csv
import io
import zipfile
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

from recipes import fdc
from recipes.fdc import Conversion, convert, load_snapshot, trim, write_snapshot

if TYPE_CHECKING:
    from collections.abc import Sequence

FIXTURE = Path(__file__).parent / "fixtures" / "fdc-snapshot.json"
ML_PER_CUP = 236.5882365
ML_PER_TBSP = 14.78676478125


@pytest.fixture(scope="module")
def snapshot() -> fdc.Snapshot:
    return load_snapshot(FIXTURE)


def ids(foods: list[fdc.Food]) -> list[int]:
    return [food.fdc_id for food in foods]


def test_a_snapshot_names_its_release(snapshot: fdc.Snapshot) -> None:
    assert snapshot.release == "foundation-2001-01-01+sr_legacy-2018-04"


def test_candidates_rank_the_closest_description_first(snapshot: fdc.Snapshot) -> None:
    # "Quill eggs, whole, raw" shares more of its words with the name than the longer SR one.
    assert ids(snapshot.candidates("whole quill eggs")) == [1002, 2003, 2008]


def test_a_description_that_starts_with_the_name_ranks_first(snapshot: fdc.Snapshot) -> None:
    # "Quill bread, egg" shares more of its words with "quill egg", but it's bread.
    assert ids(snapshot.candidates("quill egg")) == [1002, 2003, 2008]


def test_candidates_put_foundation_before_sr_legacy_on_a_tie(snapshot: fdc.Snapshot) -> None:
    assert ids(snapshot.candidates("snorp garlic")) == [3001, 2007]


def test_a_singular_name_matches_a_plural_description(snapshot: fdc.Snapshot) -> None:
    assert ids(snapshot.candidates("zorbleberry")) == [1001, 2001]


def test_candidates_break_a_tie_by_fdc_id(snapshot: fdc.Snapshot) -> None:
    assert ids(snapshot.candidates("plonk beans")) == [2005, 2006]


def test_candidates_ignore_case_punctuation_and_plurals(snapshot: fdc.Snapshot) -> None:
    assert ids(snapshot.candidates("Zorbleberries,  FROZEN!"))[0] == 2001


def test_candidates_stop_at_the_limit(snapshot: fdc.Snapshot) -> None:
    # "Zorbleberries, raw" shares half its words; three others share a third, Foundation first.
    assert ids(snapshot.candidates("raw", limit=2)) == [1001, 3001]
    assert len(snapshot.candidates("raw")) == 5


@pytest.mark.parametrize("name", ["", "unobtainium", "  ,  "])
def test_a_name_sharing_no_word_has_no_candidates(snapshot: fdc.Snapshot, name: str) -> None:
    assert snapshot.candidates(name) == []


def test_a_food_is_found_by_its_fdc_id(snapshot: fdc.Snapshot) -> None:
    assert snapshot.food(2004).description == "Glimmer oil"
    with pytest.raises(KeyError):
        snapshot.food(9)


@pytest.mark.parametrize(
    ("fdc_id", "portion_id", "density"),
    [
        (1001, 501, 144 / ML_PER_CUP),
        (2001, 601, 155 / ML_PER_CUP),  # "cup, unthawed"
        (2004, 606, 13.5 / ML_PER_TBSP),
        (2004, 607, 27 / (ML_PER_CUP / 8)),  # "fl oz"
    ],
)
def test_a_volume_portion_gives_a_density(
    snapshot: fdc.Snapshot, fdc_id: int, portion_id: int, density: float
) -> None:
    conversion = convert(snapshot.food(fdc_id), portion_id)

    assert conversion.density_g_per_ml == pytest.approx(density)
    assert (conversion.grams_per_count, conversion.count_unit, conversion.refused) == (
        None,
        None,
        None,
    )


@pytest.mark.parametrize(
    ("fdc_id", "portion_id", "grams", "unit"),
    [
        (1002, 503, 50, "large"),  # unit "each", modifier "large"
        (2003, 603, 50, "large"),
        (2007, 608, 3, "clove"),
        (1001, 502, 2, "berry"),  # 5 berries weigh 10 g
    ],
)
def test_a_count_portion_gives_grams_per_count(
    snapshot: fdc.Snapshot, fdc_id: int, portion_id: int, grams: float, unit: str
) -> None:
    conversion = convert(snapshot.food(fdc_id), portion_id)

    assert conversion == Conversion(grams_per_count=grams, count_unit=unit)


@pytest.mark.parametrize(
    ("fdc_id", "portion_id", "reason"),
    [
        (1001, None, "no portion chosen"),
        (1001, 999, "portion 999 is not one of food 1001's"),
        (2001, 602, "oz is a mass, which gives no conversion"),
        (2003, 604, "serving is neither a volume nor a count"),
        (2007, 609, "undetermined is neither a volume nor a count"),
        (2003, 605, "the portion has no amount"),
    ],
)
def test_a_portion_without_a_conversion_is_refused_with_a_reason(
    snapshot: fdc.Snapshot, fdc_id: int, portion_id: int | None, reason: str
) -> None:
    assert convert(snapshot.food(fdc_id), portion_id) == Conversion(refused=reason)


def test_the_committed_snapshot_loads_with_the_release_its_file_names() -> None:
    committed = load_snapshot()

    assert fdc.DEFAULT_PATH.name == f"{committed.release}.json.gz"
    assert committed.release == fdc.RELEASE
    assert {food.dataset for food in committed.foods} == {"foundation", "sr_legacy"}


def table(rows: Sequence[Sequence[str]]) -> str:
    out = io.StringIO()
    csv.writer(out, quoting=csv.QUOTE_ALL).writerows(rows)
    return out.getvalue()


def fdc_zip(path: Path, folder: str, files: dict[str, Sequence[Sequence[str]]]) -> Path:
    with zipfile.ZipFile(path, "w") as zf:
        for name, rows in files.items():
            zf.writestr(f"{folder}/{name}", table(rows))
    return path


FOOD = ["fdc_id", "data_type", "description", "food_category_id", "publication_date"]
NUTRIENT = ["id", "fdc_id", "nutrient_id", "amount"]
PORTION = [
    "id",
    "fdc_id",
    "seq_num",
    "amount",
    "measure_unit_id",
    "portion_description",
    "modifier",
    "gram_weight",
]
UNITS = [["id", "name"], ["1000", "cup"], ["1071", "each"], ["9999", "undetermined"]]


@pytest.fixture
def zips(tmp_path: Path) -> tuple[Path, Path]:
    foundation = fdc_zip(
        tmp_path / "foundation.zip",
        "FoodData_Central_foundation_food_csv_2001-01-01",
        {
            "food.csv": [
                FOOD,
                ["11", "foundation_food", "Wibble, raw", "9", "2001-01-01"],
                ["12", "sample_food", "WIBBLE SAMPLE", "9", "2001-01-01"],
                ["13", "foundation_food", "Wobble, raw", "9", "2001-01-01"],
            ],
            "food_nutrient.csv": [
                NUTRIENT,
                ["1", "11", "2047", "40"],
                ["2", "11", "2048", "38"],
                ["3", "11", "1003", "1.5"],
                ["4", "12", "1003", "9"],
                ["5", "13", "2047", "61"],
            ],
            "food_portion.csv": [
                PORTION,
                ["70", "11", "", "1.0", "1071", "", "large", "120"],
                ["71", "11", "", "1.0", "1000", "", "", "140"],
                ["72", "12", "", "1.0", "1000", "", "", "1"],
            ],
            "measure_unit.csv": UNITS,
        },
    )
    sr_legacy = fdc_zip(
        tmp_path / "sr.zip",
        "FoodData_Central_sr_legacy_food_csv_2018-04",
        {
            "food.csv": [FOOD, ["21", "sr_legacy_food", "Wibble, cooked", "9", "2019-04-01"]],
            "food_nutrient.csv": [
                NUTRIENT,
                ["6", "21", "1008", "52"],
                ["7", "21", "2047", "50"],
                ["8", "21", "1093", "4"],
            ],
            "food_portion.csv": [PORTION, ["80", "21", "1", "1", "9999", "", "cup, diced", "150"]],
            "measure_unit.csv": UNITS,
        },
    )
    return foundation, sr_legacy


def test_trimming_keeps_only_the_foods_and_fields_we_use(zips: tuple[Path, Path]) -> None:
    snapshot = trim(*zips, release="r")

    assert [(f.fdc_id, f.dataset) for f in snapshot.foods] == [
        (11, "foundation"),
        (13, "foundation"),
        (21, "sr_legacy"),
    ]
    wibble, wobble, cooked = snapshot.foods
    # kcal is nutrient 1008, else 2048, else 2047.
    assert [f.per_100g.kcal for f in snapshot.foods] == [38, 61, 52]
    assert (wibble.per_100g.protein_g, wibble.per_100g.sodium_mg) == (1.5, None)
    assert cooked.per_100g.sodium_mg == 4
    assert wibble.portions == (
        fdc.Portion(id=70, amount=1, unit="each", modifier="large", gram_weight=120),
        fdc.Portion(id=71, amount=1, unit="cup", modifier=None, gram_weight=140),
    )
    assert wobble.portions == ()
    # SR Legacy's portions are in an undetermined unit, written out in the modifier.
    assert cooked.portions == (
        fdc.Portion(id=80, amount=1, unit="cup, diced", modifier=None, gram_weight=150),
    )


def test_a_written_snapshot_loads_back_and_rewrites_byte_for_byte(
    zips: tuple[Path, Path], tmp_path: Path
) -> None:
    snapshot = trim(*zips, release="r")
    first = write_snapshot(snapshot, tmp_path / "a")
    second = write_snapshot(trim(*zips, release="r"), tmp_path / "b")

    assert first.name == "r.json.gz"
    assert first.read_bytes() == second.read_bytes()
    assert load_snapshot(first) == snapshot
