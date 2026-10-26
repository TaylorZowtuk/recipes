"""The enrich CLI: parse each Pending recipe's ingredient lines and write the facts to the API.

PLATEFUL_SERVICE_TOKEN=… uv run python -m recipes.enrich <API base URL>
"""

import argparse
import hashlib
import os
import sys
from http import HTTPStatus
from typing import TYPE_CHECKING, Any
from urllib.parse import urljoin, urlsplit

import requests

from recipes.auth import SERVICE_TOKEN_HEADER
from recipes.models import Enrichment, IngredientFacts, Recipe, RecipeFacts
from recipes.parse import parse_line

if TYPE_CHECKING:
    from collections.abc import Callable

# Recorded on each recipe enriched, so recipes enriched by an older version can be found.
ENRICHMENT_VERSION = 1
SERVICE_TOKEN_ENV = "PLATEFUL_SERVICE_TOKEN"
# Hosts a base URL may name over plain http: make dev's, from the host or from make shell.
LOCAL_HOSTS = {"localhost", "127.0.0.1", "api"}

# Sends one request (method, URL, body), signed in, and gives back its status and JSON body.
type Send = Callable[[str, str, bytes | None], tuple[int, Any]]


def facts_for(recipe: Recipe) -> RecipeFacts:
    """A parse fact for each of the Original's lines, across all its Components. A line the parser
    fails on is left without one, and the Ingredients tab shows its text as written.
    """
    ingredients: dict[str, IngredientFacts] = {}
    for line in recipe.original.ingredients:
        try:
            ingredients[line.id] = IngredientFacts(parse=parse_line(line.text))
        except Exception as error:
            print(f"{recipe.original.title}: left line {line.id} unparsed: {error!r}")
    return RecipeFacts(ingredients=ingredients)


def run(base_url: str, send: Send) -> int:
    """Enrich every Pending recipe, printing each one's new status. Returns how many failed."""
    status, collection = send("GET", f"{base_url}/api/collection", None)
    if status != HTTPStatus.OK:
        print(f"Couldn't list the Collection: {status} {collection}")
        return 1
    pending = [card for card in collection["cards"] if card["status"] == "pending"]
    failed = 0
    for card in pending:
        status, body = send("GET", f"{base_url}/api/recipes/{card['id']}", None)
        if status == HTTPStatus.OK:
            recipe = Recipe.model_validate(body)
            enrichment = Enrichment(enrichment_version=ENRICHMENT_VERSION, facts=facts_for(recipe))
            url = f"{base_url}/api/recipes/{recipe.id}/enrichment"
            status, body = send("PUT", url, enrichment.model_dump_json().encode())
        if status == HTTPStatus.OK:
            print(f"{card['title']} → {body['status']}")
        else:
            failed += 1
            print(f"{card['title']} → failed: {status} {body}")
    print(f"Enriched {len(pending) - failed} of {len(pending)} Pending recipes, {failed} failed")
    return failed


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


def main() -> None:
    parser = argparse.ArgumentParser(description="Enrich every Pending recipe through the API.")
    parser.add_argument("base_url", help="the API's base URL, e.g. http://localhost:5173")
    args = parser.parse_args()
    base_url = checked_base_url(args.base_url)
    token = os.environ.get(SERVICE_TOKEN_ENV)
    if not token:
        sys.exit(f"Set {SERVICE_TOKEN_ENV} to the stack's service token")
    with SameOriginSession() as session:
        failed = run(base_url, send_with(session, token))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
