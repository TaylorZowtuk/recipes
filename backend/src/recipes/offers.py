"""The numbers written in recipe text, and the durations and temperatures code finds in a step's
text: what the Work Packet offers a model, and all a step's segments may say there.
"""

import math
import re
import unicodedata

from recipes.models import DurationSegment, TemperatureSegment

VULGAR = "¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞"
NUMBER = re.compile(
    rf"""(?P<whole>\d+)(?:\s+|-)(?P<num>\d+)/(?P<den>\d+)  # 1 1/2, 1-1/2
    |(?P<fnum>\d+)/(?P<fden>\d+)                          # 1/2
    |(?P<uwhole>\d+)?\s*(?P<vulgar>[{VULGAR}])            # ½, 1½, 1 ½
    |(?P<decimal>\d*\.\d+|\d+)                            # 2, 2.5, .5""",
    re.VERBOSE,
)
# A number written in a step: 1 1/2, 1/2, 1½, 2.5 or 2. NUMBER reads its value.
STEP_NUMBER = rf"\d+\s+\d+/\d+|\d+/\d+|(?:\d+\s*)?[{VULGAR}]|\d+(?:\.\d+)?"
# A time in a step: "8-10 minutes", "8 to 10 minutes", "1½ hours", "45 min", "30 secs".
DURATION = re.compile(
    rf"(?<![\w.])(?P<low>{STEP_NUMBER})(?:\s*(?:-|\u2013|to)\s*(?P<high>{STEP_NUMBER}))?\s*"
    r"(?P<unit>hours?|hrs?|minutes?|mins?|seconds?|secs?)\b",
    re.IGNORECASE,
)
SECONDS_IN = {"h": 3600, "m": 60, "s": 1}
# A temperature in a step: "350°F", "180 °C", "180C", "425 degrees F". "2 C" may be cups, so a
# scale with neither a degree sign nor "degrees" is written right after its number.
TEMPERATURE = re.compile(
    r"(?<![\w.])(?P<degrees>\d+)(?:\s*[°º]\s*|\s+(?i:degrees?)\s+|)(?P<scale>[FC])"
    r"(?:ahrenheit|elsius)?\b"
)


def number_value(match: re.Match[str]) -> float | None:
    """The value of a NUMBER match, or None for a fraction with a zero denominator."""
    if match["den"]:
        den = int(match["den"])
        return int(match["whole"]) + int(match["num"]) / den if den else None
    if match["fden"]:
        den = int(match["fden"])
        return int(match["fnum"]) / den if den else None
    if match["vulgar"]:
        return int(match["uwhole"] or 0) + unicodedata.numeric(match["vulgar"])
    return float(match["decimal"])


def _step_number(text: str) -> float | None:
    match = NUMBER.fullmatch(text)
    return number_value(match) if match else None


# A duration or temperature found in a step's text, with where it starts.
type Found = tuple[int, DurationSegment | TemperatureSegment]


def find_offers(text: str) -> list[Found]:
    """The durations and temperatures written in a step's text, in the order they're written:
    a duration as a range of seconds, a temperature in whole degrees Celsius.
    """
    found: list[Found] = []
    for match in DURATION.finditer(text):
        seconds = SECONDS_IN[match["unit"][0].lower()]
        low = _step_number(match["low"])
        high = _step_number(match["high"]) if match["high"] else low
        if low is None or high is None or high < low:
            continue
        found.append(
            (
                match.start(),
                DurationSegment(
                    low_s=round(low * seconds), high_s=round(high * seconds), written=match[0]
                ),
            )
        )
    for match in TEMPERATURE.finditer(text):
        degrees = int(match["degrees"])
        celsius = (degrees - 32) * 5 / 9 if match["scale"] == "F" else degrees
        found.append(
            (match.start(), TemperatureSegment(c=math.floor(celsius + 0.5), written=match[0]))
        )
    found.sort(key=lambda each: each[0])
    # Neither pattern overlaps itself, but keep the first should one overlap the other.
    kept: list[Found] = []
    for start, segment in found:
        if not kept or start >= kept[-1][0] + len(kept[-1][1].written):
            kept.append((start, segment))
    return kept
