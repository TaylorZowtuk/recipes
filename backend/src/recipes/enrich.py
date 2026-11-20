"""The enrich CLI: hands a model a Work Packet of every Pending recipe, then checks the model's
answer against what the packet offered and writes each recipe's facts through the API. A
Substitutes Packet comes first, whose answer (the substitutes file) the Work Packet offers
candidates for. With --recipe or --stale, all three re-enrich those recipes instead, and apply
prints each one's fact changes, writing them only with --write.

PLATEFUL_SERVICE_TOKEN=… uv run python -m recipes.enrich substitutes <API base URL> > ask.json
PLATEFUL_SERVICE_TOKEN=… uv run python -m recipes.enrich packet <API base URL> \
    --substitutes substitutes.json > packet.json
PLATEFUL_SERVICE_TOKEN=… uv run python -m recipes.enrich apply <API base URL> <answer.json | -> \
    --substitutes substitutes.json
PLATEFUL_SERVICE_TOKEN=… uv run python -m recipes.enrich stale <API base URL>
"""

import argparse
import os
import sys
from dataclasses import dataclass
from http import HTTPStatus
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

from pydantic import ValidationError

from recipes.client import (
    SERVICE_TOKEN_ENV,
    SameOriginSession,
    Send,
    checked_base_url,
    send_with,
)
from recipes.fdc import Snapshot, load_snapshot
from recipes.models import (
    CanonicalIngredient,
    ConversionFact,
    DifficultyFact,
    Enrichment,
    Fact,
    KitchenSettings,
    MatchFact,
    ParseFact,
    Recipe,
    SegmentsFact,
    SubstitutionsFact,
    UsesFact,
    Wording,
    fact_at,
    fact_paths,
)
from recipes.packet import ENRICHMENT_VERSION, Answer, Rejected, Work
from recipes.substitutes import Substitutes, checked, substitutes_packet

if TYPE_CHECKING:
    from collections.abc import Callable


@dataclass(frozen=True)
class Chosen:
    """The recipes to re-enrich in place of the Pending ones: those `ids` names, or with no ids,
    every enriched recipe that is stale against the FDC Snapshot release `stale`.
    """

    ids: tuple[str, ...] = ()
    stale: str | None = None


def is_stale(recipe: Recipe, release: str) -> bool:
    return recipe.enrichment_version != ENRICHMENT_VERSION or recipe.fdc_release != release


def fetch_recipes(
    base_url: str, send: Send, chosen: Chosen | None = None
) -> tuple[Any, list[Recipe]] | None:
    """The Collection and its Pending recipes, or the chosen ones, or None when the API couldn't
    give them or a chosen id isn't an enriched recipe, which is printed to stderr.
    """
    status, collection = send("GET", f"{base_url}/api/collection", None)
    if status != HTTPStatus.OK:
        print(f"Couldn't list the Collection: {status} {collection}", file=sys.stderr)
        return None
    cards = {card["id"]: card for card in collection["cards"]}
    if chosen is None or not chosen.ids:
        pending = chosen is None
        ids = [id_ for id_, card in cards.items() if (card["status"] == "pending") == pending]
    else:
        ids = list(dict.fromkeys(chosen.ids))
        refusals = [
            f"{id_} isn't a recipe in the Collection"
            if id_ not in cards
            else f"{id_} {cards[id_]['title']} is Pending: enrich it without --recipe"
            for id_ in ids
            if id_ not in cards or cards[id_]["status"] == "pending"
        ]
        if refusals:
            print("\n".join(refusals), file=sys.stderr)
            return None
    recipes: list[Recipe] = []
    for id_ in ids:
        status, body = send("GET", f"{base_url}/api/recipes/{id_}", None)
        if status != HTTPStatus.OK:
            print(f"Couldn't read {cards[id_]['title']}: {status} {body}", file=sys.stderr)
            return None
        recipes.append(Recipe.model_validate(body))
    if chosen and chosen.stale:
        recipes = [recipe for recipe in recipes if is_stale(recipe, chosen.stale)]
    return collection, recipes


def fetch_work(
    base_url: str,
    send: Send,
    snapshot: Snapshot,
    substitutes: Substitutes | None = None,
    chosen: Chosen | None = None,
) -> Work | None:
    """The Collection's Pending (or chosen) recipes, Canonical Ingredients, wordings and Store
    Categories, with the substitutes each recipe states, or None when the API couldn't give them
    or the substitutes file quotes what its recipes don't say, which is printed to stderr.
    """
    fetched = fetch_recipes(base_url, send, chosen)
    if fetched is None:
        return None
    collection, recipes = fetched
    try:
        stated = checked(substitutes, recipes) if substitutes else {}
    except Rejected as rejected:
        print("The substitutes file doesn't match the recipes:", file=sys.stderr)
        print("\n".join(f"  {error}" for error in rejected.errors), file=sys.stderr)
        return None
    return Work(
        recipes=recipes,
        canonical_ingredients=[
            CanonicalIngredient.model_validate(c) for c in collection["canonical_ingredients"]
        ],
        wordings=[Wording.model_validate(w) for w in collection["wordings"]],
        store_categories=KitchenSettings.model_validate(
            collection["kitchen_settings"]
        ).store_categories,
        snapshot=snapshot,
        substitutes=stated,
    )


def stale(base_url: str, send: Send, release: str) -> int:
    """Print each enriched recipe whose enrichment version or FDC release isn't the current one,
    writing nothing. Returns 1 when the API couldn't give them.
    """
    fetched = fetch_recipes(base_url, send, Chosen(stale=release))
    if fetched is None:
        return 1
    for recipe in fetched[1]:
        print(
            f"{recipe.id} {recipe.original.title}: enrichment version "
            f"{recipe.enrichment_version or 'none'}, FDC release {recipe.fdc_release or 'none'} "
            f"(now {ENRICHMENT_VERSION}, {release})"
        )
    return 0


def ask(base_url: str, send: Send, chosen: Chosen | None = None) -> int:
    """Print the Substitutes Packet for every Pending (or chosen) recipe, writing nothing. Returns
    1 when the API couldn't give it.
    """
    fetched = fetch_recipes(base_url, send, chosen)
    if fetched is None:
        return 1
    print(substitutes_packet(fetched[1]).model_dump_json(indent=2))
    return 0


def packet(
    base_url: str,
    send: Send,
    snapshot: Snapshot,
    substitutes: Substitutes | None = None,
    chosen: Chosen | None = None,
) -> int:
    """Print the Work Packet for every Pending (or chosen) recipe, with offers for each substitute
    the substitutes file quotes, writing nothing. Returns 1 when the API couldn't give it or the
    substitutes file doesn't match the recipes.
    """
    work = fetch_work(base_url, send, snapshot, substitutes, chosen)
    if work is None:
        return 1
    print(work.packet().model_dump_json(indent=2))
    return 0


def apply(
    base_url: str,
    send: Send,
    snapshot: Snapshot,
    text: str,
    substitutes: Substitutes | None = None,
    *,
    chosen: Chosen | None = None,
    write: bool = False,
) -> int:
    """Check a model's answer against the packet it answers, rebuilt from the API and the same
    substitutes file, and write each recipe whose offer hasn't changed since and whose every line
    chose among its offers. Prints each recipe's result and returns how many were rejected or
    failed to write. Re-enriching chosen recipes, it first prints each one's fact changes from a
    dry run, and writes them only with `write`.
    """
    try:
        answer = Answer.model_validate_json(text)
    except ValidationError as error:
        print(f"That isn't an answer to a Work Packet: {error}")
        return 1
    work = fetch_work(base_url, send, snapshot, substitutes, chosen)
    if work is None:
        return 1
    failed = 0
    for answered in answer.recipes:
        title = work.title(answered.recipe_id)
        try:
            enrichment = work.enrich(answered, answer.model)
        except Rejected as rejected:
            failed += 1
            print(f"{title} → rejected, nothing written:")
            print("\n".join(f"  {error}" for error in rejected.errors))
            continue
        stored = work.recipes[answered.recipe_id][0]
        reenriching = chosen is not None
        if not sent(base_url, send, work, enrichment, stored, reenriching=reenriching, write=write):
            failed += 1
    count = len(answer.recipes)
    if chosen is not None and not write:
        print(f"Checked {count - failed} of {count} answered recipes, {failed} failed")
        print("Nothing written: rerun apply with --write to write these changes")
    else:
        print(f"Enriched {count - failed} of {count} answered recipes, {failed} failed")
    return failed


def sent(
    base_url: str,
    send: Send,
    work: Work,
    enrichment: Enrichment,
    stored: Recipe,
    *,
    reenriching: bool,
    write: bool,
) -> bool:
    """Write one recipe's enrichment and print its status and Enrichment Issues. Re-enriching, a
    dry run first prints its fact changes, and only `write` writes them. False when the API
    refused it.
    """
    title, body_bytes = stored.original.title, enrichment.model_dump_json().encode()
    url = f"{base_url}/api/recipes/{stored.id}/enrichment"
    if reenriching:
        status, body = send("PUT", f"{url}?dry_run=true", body_bytes)
        if status != HTTPStatus.OK:
            print(f"{title} → failed: {status} {body}")
            return False
        canonicals = [*work.canonicals.values(), *enrichment.canonical_ingredients]
        names = {canonical.id: canonical.name for canonical in canonicals}
        print(f"{title}:")
        for change in changes(stored, Recipe.model_validate(body), names):
            print(f"  {change}")
        if not write:
            return True
    status, body = send("PUT", url, body_bytes)
    if status != HTTPStatus.OK:
        print(f"{title} → failed: {status} {body}")
        return False
    work.learn(enrichment)
    print(f"{title} → {body['status']}")
    # A re-enrichment's issue changes are in the diff above it.
    if not reenriching:
        for issue in body["issues"]:
            print(f"  {issue_line(issue)}")
    return True


def changes(before: Recipe, after: Recipe, names: dict[str, str]) -> list[str]:
    """What re-enrichment changes in a recipe, a line each: every fact added, removed or changed,
    every Enrichment Issue added or dropped, and its enrichment version and FDC release.
    """
    lines: list[str] = []
    for path in dict.fromkeys([*fact_paths(before.facts), *fact_paths(after.facts)]):
        was, now = fact_at(before.facts, path), fact_at(after.facts, path)
        if was == now:
            continue
        if was is None or now is None:
            verb = "added" if was is None else "removed"
            lines.append(f"{path} {verb}: {summary(now or was, names)}")
        elif (said := summary(was, names)) == summary(now, names):
            lines.append(f"{path} changed: {said}: {differences(was, now)}")
        else:
            lines.append(f"{path} changed: {said} → {summary(now, names)}")
    old = {(i.fact_id, i.before, i.after, i.reason) for i in before.issues}
    new = {(i.fact_id, i.before, i.after, i.reason) for i in after.issues}
    lines += [
        f"issue {verb}: {issue_line(issue.model_dump())}"
        for verb, issues, other in (("dropped", before.issues, new), ("added", after.issues, old))
        for issue in issues
        if (issue.fact_id, issue.before, issue.after, issue.reason) not in other
    ]
    if not lines:
        lines.append("no fact changes")
    if before.enrichment_version != after.enrichment_version:
        lines.append(f"enrichment version {before.enrichment_version} → {after.enrichment_version}")
    if before.fdc_release != after.fdc_release:
        lines.append(f"FDC release {before.fdc_release} → {after.fdc_release}")
    return lines


def differences(was: Fact, now: Fact) -> str:
    """Each field that differs between two facts, a nested one as `per_100g.kcal`, with its
    values before and after.
    """

    def flat(fact: Fact) -> dict[str, object]:
        fields: dict[str, object] = {}
        for name, value in fact.model_dump(mode="json").items():
            if isinstance(value, dict):
                nested = cast("dict[str, object]", value)
                fields |= {f"{name}.{key}": inner for key, inner in nested.items()}
            else:
                fields[name] = value
        return fields

    before, after = flat(was), flat(now)
    return ", ".join(
        f"{name} {_shown(before.get(name))} → {_shown(after.get(name))}"
        for name in dict.fromkeys([*before, *after])
        if before.get(name) != after.get(name)
    )


def _shown(value: object) -> str:
    return f"{value:g}" if isinstance(value, float) else str(value)


def summary(fact: Fact | None, names: dict[str, str]) -> str:
    """A fact in a few words, for a change line: its main values."""
    match fact:
        case ParseFact(quantity=quantity, unit=unit, name=name):
            amount = quantity and f"{quantity.low:g}" + (
                f"-{quantity.high:g}" if quantity.high != quantity.low else ""
            )
            text = " ".join(part for part in (amount, unit, name) if part)
        case MatchFact(canonical_id=canonical_id, fdc_id=fdc_id):
            text = f"{names.get(canonical_id, canonical_id)} (FDC {fdc_id})"
        case ConversionFact(fdc_id=fdc_id):
            text = f"FDC {fdc_id}"
        case SubstitutionsFact(items=items):
            text = ", ".join(item.wording for item in items)
        case SegmentsFact(segments=segments):
            text = f"{len(segments)} segments"
        case UsesFact(uses=uses):
            text = ", ".join(f"{use.ref} {use.portion:g}" for use in uses) or "none"
        case DifficultyFact(prep=prep, cook=cook, cleanup=cleanup):
            text = f"prep {prep}, cook {cook}, cleanup {cleanup}"
        case _:
            text = "(details)"
    return text


def issue_line(issue: dict[str, Any]) -> str:
    """An Enrichment Issue on one line: its fact, what it was before and after (or "(none)"),
    and the reason.
    """
    before, after = issue.get("before"), issue.get("after")
    return f"{issue['fact_id']}: {before or '(none)'} → {after or '(none)'} — {issue['reason']}"


def read_answer(source: str) -> str:
    """The model's answer, from a file or, for "-", stdin."""
    return sys.stdin.read() if source == "-" else Path(source).read_text()


def read_substitutes(path: str | None) -> Substitutes | None:
    """The substitutes file at `path`, if one is given. Stops when it isn't one."""
    if path is None:
        return None
    try:
        text = Path(path).read_text()
    except OSError as error:
        sys.exit(f"Couldn't read {path}: {error}")
    try:
        return Substitutes.model_validate_json(text)
    except ValidationError as error:
        sys.exit(f"That isn't a substitutes file: {error}")


def chosen_by(args: argparse.Namespace, release: Callable[[], str]) -> Chosen | None:
    """The recipes --recipe or --stale chose, or None for the Pending ones. Only --stale needs
    the FDC Snapshot's release.
    """
    if args.recipe:
        return Chosen(ids=tuple(args.recipe))
    return Chosen(stale=release()) if args.stale else None


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m recipes.enrich", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    base_help = "the API's base URL, e.g. http://localhost:5173"
    substitutes_help = "the substitutes file: the answer to the Substitutes Packet"
    stale_command = commands.add_parser(
        "stale", help="list recipes enriched at an older enrichment version or FDC release"
    )
    stale_command.add_argument("base_url", help=base_help)
    substitutes_command = commands.add_parser(
        "substitutes", help="print the Substitutes Packet, writing nothing"
    )
    substitutes_command.add_argument("base_url", help=base_help)
    packet_command = commands.add_parser("packet", help="print the Work Packet, writing nothing")
    packet_command.add_argument("base_url", help=base_help)
    packet_command.add_argument("--substitutes", help=substitutes_help)
    apply_command = commands.add_parser("apply", help="check a model's answer and write it")
    apply_command.add_argument("base_url", help=base_help)
    apply_command.add_argument("answer", help="the answer's file, or - for stdin")
    apply_command.add_argument("--substitutes", help=substitutes_help)
    apply_command.add_argument(
        "--write", action="store_true", help="write the re-enrichment its dry run printed"
    )
    for command in (substitutes_command, packet_command, apply_command):
        choice = command.add_mutually_exclusive_group()
        choice.add_argument(
            "--recipe", action="append", metavar="ID", help="re-enrich this recipe (repeatable)"
        )
        choice.add_argument("--stale", action="store_true", help="re-enrich what stale lists")
    args = parser.parse_args(argv)
    if getattr(args, "write", False) and not (args.recipe or args.stale):
        parser.error("--write needs --recipe or --stale: Pending recipes are written without it")
    base_url = checked_base_url(args.base_url)
    token = os.environ.get(SERVICE_TOKEN_ENV)
    if not token:
        sys.exit(f"Set {SERVICE_TOKEN_ENV} to the stack's service token")
    with SameOriginSession() as session:
        send = send_with(session, token)
        match args.command:
            case "stale":
                failed = stale(base_url, send, load_snapshot().release)
            case "substitutes":
                failed = ask(base_url, send, chosen_by(args, lambda: load_snapshot().release))
            case "packet":
                substitutes = read_substitutes(args.substitutes)
                snapshot = load_snapshot()
                chosen = chosen_by(args, lambda: snapshot.release)
                failed = packet(base_url, send, snapshot, substitutes, chosen)
            case _:
                text = read_answer(args.answer)
                substitutes = read_substitutes(args.substitutes)
                snapshot = load_snapshot()
                chosen = chosen_by(args, lambda: snapshot.release)
                failed = apply(
                    base_url, send, snapshot, text, substitutes, chosen=chosen, write=args.write
                )
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
