"""The bulk import CLI: ingests each website Source in a sources file through the API, saving what
a plain fetch captures as the bulk import, so enrichment takes it straight to Ready. A Source the
fetch can't read is left as a Queued Ingest for the fallback, which finishes it as Add a recipe.

PLATEFUL_SERVICE_TOKEN=… uv run python -m recipes.bulk_import <API base URL> <sources.csv | ->

The sources file is CSV with the header `kind,location,notes`. Only `website` rows are ingested,
and `notes` is ignored. A Source already in the Collection or queued is skipped, so a re-run is
safe.
"""

import argparse
import csv
import io
import json
import os
import sys
from http import HTTPStatus
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from recipes.client import (
    SERVICE_TOKEN_ENV,
    SameOriginSession,
    Send,
    checked_base_url,
    send_with,
)
from recipes.fallback import new_recipe, stored_photos
from recipes.models import Original, WebsiteSource

if TYPE_CHECKING:
    from collections.abc import Iterable


type Outcome = Literal["ingested", "skipped", "queued"]


class Refused(Exception):
    """The API didn't do what was asked: its status and the detail it gave."""

    def __init__(self, status: int, answer: object) -> None:
        super().__init__(f"{status} {_detail(answer)}")


def _say(message: str) -> None:
    print(message, file=sys.stderr)


def _post(send: Send, url: str, body: dict[str, Any]) -> tuple[int, Any]:
    return send("POST", url, json.dumps(body).encode())


def _detail(answer: object) -> str:
    return str(answer.get("detail", answer)) if isinstance(answer, dict) else str(answer)  # pyright: ignore[reportUnknownMemberType, reportUnknownArgumentType]


def _import(base_url: str, send: Send, url: str) -> tuple[Outcome, str]:
    """Ingest one website Source: its outcome (ingested, skipped or queued) and how to say it."""
    status, answer = _post(send, f"{base_url}/api/ingest", {"url": url})
    if status == HTTPStatus.CONFLICT:
        return "skipped", f"skipped ({_detail(answer)})"
    if status == HTTPStatus.ACCEPTED:
        return "queued", f"queued for the fallback ({answer['reason']})"
    if status != HTTPStatus.OK:
        raise Refused(status, answer)
    source = WebsiteSource.model_validate(answer["source"])
    original = Original.model_validate(answer["original"])
    images = stored_photos(base_url, send, answer["candidate_photos"])
    recipe = {**new_recipe(source, original, images=images), "ingest_channel": "bulk_import"}
    status, answer = _post(send, f"{base_url}/api/recipes", recipe)
    if status == HTTPStatus.CONFLICT:
        return "skipped", f"skipped ({_detail(answer)})"
    if status != HTTPStatus.CREATED:
        raise Refused(status, answer)
    return "ingested", "ingested"


def run(base_url: str, send: Send, sources: Iterable[str]) -> int:
    """Ingest each website Source in `sources`, printing each outcome as it goes and then a
    summary. Returns how many failed: a failure is that Source's alone, and the others go on.
    """
    counts: dict[Outcome, int] = {"ingested": 0, "skipped": 0, "queued": 0}
    failures: list[tuple[str, str]] = []
    for row in csv.DictReader(sources):
        location = row["location"]
        if row["kind"] != "website":
            counts["skipped"] += 1
            _say(f"{location} → skipped (not a website Source)")
            continue
        try:
            outcome, said = _import(base_url, send, location)
        except Exception as error:
            failures.append((location, str(error)))
            _say(f"{location} → failed: {error}")
            continue
        counts[outcome] += 1
        _say(f"{location} → {said}")
    print(
        f"Ingested {counts['ingested']}, skipped {counts['skipped']}, "
        f"queued {counts['queued']}, failed {len(failures)}"
    )
    if failures:
        print("Failed:")
        for location, reason in failures:
            print(f"  {location}: {reason}")
    if counts["queued"]:
        print(
            "Run the fallback to finish the queued Sources: "
            f"make fallback ARGS='run {base_url}', or the enrich-pending skill"
        )
    return len(failures)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m recipes.bulk_import", description=__doc__)
    parser.add_argument("base_url", help="the API's base URL, e.g. http://localhost:5173")
    parser.add_argument("sources", help="the sources file, or - for stdin")
    args = parser.parse_args(argv)
    base_url = checked_base_url(args.base_url)
    token = os.environ.get(SERVICE_TOKEN_ENV)
    if not token:
        sys.exit(f"Set {SERVICE_TOKEN_ENV} to the stack's service token")
    if args.sources == "-":
        text = sys.stdin.read()
    else:
        text = Path(args.sources).read_text(encoding="utf-8")
    with SameOriginSession() as session:
        failed = run(base_url, send_with(session, token), io.StringIO(text, newline=""))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
