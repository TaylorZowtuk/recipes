"""The enrich CLI: hands a model a Work Packet of every Pending recipe, then checks the model's
answer against what the packet offered and writes each recipe's facts through the API.

PLATEFUL_SERVICE_TOKEN=… uv run python -m recipes.enrich packet <API base URL> > packet.json
PLATEFUL_SERVICE_TOKEN=… uv run python -m recipes.enrich apply <API base URL> <answer.json | ->
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
from recipes.packet import Answer, Rejected, Work

if TYPE_CHECKING:
    from collections.abc import Callable

SERVICE_TOKEN_ENV = "PLATEFUL_SERVICE_TOKEN"
# Hosts a base URL may name over plain http: make dev's, from the host or from make shell.
LOCAL_HOSTS = {"localhost", "127.0.0.1", "api"}

# Sends one request (method, URL, body), signed in, and gives back its status and JSON body.
type Send = Callable[[str, str, bytes | None], tuple[int, Any]]


def fetch_work(base_url: str, send: Send, snapshot: Snapshot) -> Work | None:
    """The Collection's Pending recipes, Canonical Ingredients, wordings and Store Categories, or
    None when the API couldn't give them, which is printed to stderr.
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
    )


def packet(base_url: str, send: Send, snapshot: Snapshot) -> int:
    """Print the Work Packet for every Pending recipe, writing nothing. Returns 1 when the API
    couldn't give it.
    """
    work = fetch_work(base_url, send, snapshot)
    if work is None:
        return 1
    print(work.packet().model_dump_json(indent=2))
    return 0


def apply(base_url: str, send: Send, snapshot: Snapshot, text: str) -> int:
    """Check a model's answer against the packet it answers, rebuilt from the API, and write each
    recipe whose every line chose among its offers. Prints each recipe's result and returns how
    many were rejected or failed to write.
    """
    try:
        answer = Answer.model_validate_json(text)
    except ValidationError as error:
        print(f"That isn't an answer to a Work Packet: {error}")
        return 1
    work = fetch_work(base_url, send, snapshot)
    if work is None:
        return 1
    if answer.packet_id != work.packet().packet_id:
        print(
            "The answer is to another packet: the Pending recipes, Canonical Ingredients or "
            "wordings changed since. Make a new packet and answer that."
        )
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


class SameOriginSession(requests.Session):
    """Follows a redirect only on the same scheme and host, so the service token goes nowhere
    else. The collection listing redirects to its current version on the same host.
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
    packet_command = commands.add_parser("packet", help="print the Work Packet, writing nothing")
    packet_command.add_argument("base_url", help=base_help)
    apply_command = commands.add_parser("apply", help="check a model's answer and write it")
    apply_command.add_argument("base_url", help=base_help)
    apply_command.add_argument("answer", help="the answer's file, or - for stdin")
    args = parser.parse_args(argv)
    base_url = checked_base_url(args.base_url)
    token = os.environ.get(SERVICE_TOKEN_ENV)
    if not token:
        sys.exit(f"Set {SERVICE_TOKEN_ENV} to the stack's service token")
    text = read_answer(args.answer) if args.command == "apply" else None
    snapshot = load_snapshot()
    with SameOriginSession() as session:
        send = send_with(session, token)
        failed = (
            packet(base_url, send, snapshot)
            if text is None
            else apply(base_url, send, snapshot, text)
        )
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
