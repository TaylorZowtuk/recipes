"""The enrich CLI: hands a model a Work Packet of every Pending recipe, then checks the model's
answer against what the packet offered and writes each recipe's facts through the API. A
Substitutes Packet comes first, whose answer (the substitutes file) the Work Packet offers
candidates for.

PLATEFUL_SERVICE_TOKEN=… uv run python -m recipes.enrich substitutes <API base URL> > ask.json
PLATEFUL_SERVICE_TOKEN=… uv run python -m recipes.enrich packet <API base URL> \
    --substitutes substitutes.json > packet.json
PLATEFUL_SERVICE_TOKEN=… uv run python -m recipes.enrich apply <API base URL> <answer.json | -> \
    --substitutes substitutes.json
"""

import argparse
import hashlib
import os
import sys
from http import HTTPStatus
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import urljoin, urlsplit

import requests
from pydantic import ValidationError

from recipes.auth import SERVICE_TOKEN_HEADER
from recipes.fdc import Snapshot, load_snapshot
from recipes.models import CanonicalIngredient, KitchenSettings, Recipe, Wording
from recipes.packet import Answer, Rejected, Substitutes, Work

if TYPE_CHECKING:
    from collections.abc import Callable

SERVICE_TOKEN_ENV = "PLATEFUL_SERVICE_TOKEN"
# Hosts a base URL may name over plain http: make dev's, from the host or from make shell.
LOCAL_HOSTS = {"localhost", "127.0.0.1", "api"}

# Sends one request (method, URL, body), signed in, and gives back its status and JSON body.
type Send = Callable[[str, str, bytes | None], tuple[int, Any]]


def fetch_work(
    base_url: str, send: Send, snapshot: Snapshot, substitutes: Substitutes | None = None
) -> Work | None:
    """The Collection's Pending recipes, Canonical Ingredients, wordings and Store Categories, or
    None when the API couldn't give them or the substitutes file quotes what its recipes don't
    say, which is printed to stderr.
    """
    status, collection = send("GET", f"{base_url}/api/collection", None)
    if status != HTTPStatus.OK:
        print(f"Couldn't list the Collection: {status} {collection}", file=sys.stderr)
        return None
    recipes: list[Recipe] = []
    for card in collection["cards"]:
        if card["status"] != "pending":
            continue
        status, body = send("GET", f"{base_url}/api/recipes/{card['id']}", None)
        if status != HTTPStatus.OK:
            print(f"Couldn't read {card['title']}: {status} {body}", file=sys.stderr)
            return None
        recipes.append(Recipe.model_validate(body))
    try:
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
            substitutes=substitutes,
        )
    except Rejected as rejected:
        print("The substitutes file doesn't match the Pending recipes:", file=sys.stderr)
        print("\n".join(f"  {error}" for error in rejected.errors), file=sys.stderr)
        return None


def substitutes(base_url: str, send: Send, snapshot: Snapshot) -> int:
    """Print the Substitutes Packet for every Pending recipe, writing nothing. Returns 1 when the
    API couldn't give it.
    """
    work = fetch_work(base_url, send, snapshot)
    if work is None:
        return 1
    print(work.substitutes_packet().model_dump_json(indent=2))
    return 0


def packet(base_url: str, send: Send, snapshot: Snapshot, quoted: Substitutes | None = None) -> int:
    """Print the Work Packet for every Pending recipe, with offers for each substitute the
    substitutes file quotes, writing nothing. Returns 1 when the API couldn't give it or the
    substitutes file doesn't match the recipes.
    """
    work = fetch_work(base_url, send, snapshot, quoted)
    if work is None:
        return 1
    print(work.packet().model_dump_json(indent=2))
    return 0


def apply(
    base_url: str, send: Send, snapshot: Snapshot, text: str, quoted: Substitutes | None = None
) -> int:
    """Check a model's answer against the packet it answers, rebuilt from the API and the same
    substitutes file, and write each recipe whose offer hasn't changed since and whose every line
    chose among its offers. Prints each recipe's result and returns how many were rejected or
    failed to write.
    """
    try:
        answer = Answer.model_validate_json(text)
    except ValidationError as error:
        print(f"That isn't an answer to a Work Packet: {error}")
        return 1
    work = fetch_work(base_url, send, snapshot, quoted)
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
        url = f"{base_url}/api/recipes/{answered.recipe_id}/enrichment"
        status, body = send("PUT", url, enrichment.model_dump_json().encode())
        if status == HTTPStatus.OK:
            work.learn(enrichment)
            print(f"{title} → {body['status']}")
        else:
            failed += 1
            print(f"{title} → failed: {status} {body}")
    count = len(answer.recipes)
    print(f"Enriched {count - failed} of {count} answered recipes, {failed} failed")
    return failed


def read_answer(source: str) -> str:
    """The model's answer, from a file or, for "-", stdin."""
    return sys.stdin.read() if source == "-" else Path(source).read_text()


def read_substitutes(path: str | None) -> Substitutes | None:
    """The substitutes file at `path`, if one is given. Stops when it isn't one."""
    if path is None:
        return None
    try:
        return Substitutes.model_validate_json(Path(path).read_text())
    except ValidationError as error:
        sys.exit(f"That isn't a substitutes file: {error}")


class SameOriginSession(requests.Session):
    """Follows a redirect only on the same scheme and host, so the service token goes nowhere
    else. The unversioned Collection and recipe reads redirect to their current versions on
    the same host.
    """

    def get_redirect_target(self, resp: requests.Response) -> str | None:
        target = super().get_redirect_target(resp)
        if target and _origin(urljoin(resp.url, target)) != _origin(resp.url):
            return None
        return target


def send_with(session: requests.Session, token: str) -> Send:
    """Sends through `session` with the service token. A body is JSON, sent with its SHA-256,
    which CloudFront's OAC signs the request to the API with.
    """

    def send(method: str, url: str, body: bytes | None) -> tuple[int, Any]:
        headers = {SERVICE_TOKEN_HEADER: token}
        if body is not None:
            headers["content-type"] = "application/json"
            headers["x-amz-content-sha256"] = hashlib.sha256(body).hexdigest()
        response = session.request(method, url, headers=headers, data=body, timeout=60)
        try:
            return response.status_code, response.json()
        except requests.JSONDecodeError:
            return response.status_code, response.text

    return send


def checked_base_url(url: str) -> str:
    """The base URL without a trailing slash, if it's https or a local dev host's http."""
    parts = urlsplit(url)
    if parts.scheme != "https" and not (parts.scheme == "http" and parts.hostname in LOCAL_HOSTS):
        sys.exit(f"The base URL must be https, or http on {', '.join(sorted(LOCAL_HOSTS))}: {url}")
    return url.rstrip("/")


def _origin(url: str) -> tuple[str, str | None, int | None]:
    parts = urlsplit(url)
    return parts.scheme, parts.hostname, parts.port


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m recipes.enrich", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    base_help = "the API's base URL, e.g. http://localhost:5173"
    substitutes_help = "the substitutes file: the answer to the Substitutes Packet"
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
    args = parser.parse_args(argv)
    base_url = checked_base_url(args.base_url)
    token = os.environ.get(SERVICE_TOKEN_ENV)
    if not token:
        sys.exit(f"Set {SERVICE_TOKEN_ENV} to the stack's service token")
    text = read_answer(args.answer) if args.command == "apply" else None
    quoted = read_substitutes(getattr(args, "substitutes", None))
    snapshot = load_snapshot()
    with SameOriginSession() as session:
        send = send_with(session, token)
        if args.command == "substitutes":
            failed = substitutes(base_url, send, snapshot)
        elif text is None:
            failed = packet(base_url, send, snapshot, quoted)
        else:
            failed = apply(base_url, send, snapshot, text, quoted)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
