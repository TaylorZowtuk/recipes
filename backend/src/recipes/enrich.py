"""The enrich CLI: parse each Pending recipe's ingredient lines and write the facts to the API.

PLATEFUL_SERVICE_TOKEN=… uv run python -m recipes.enrich <API base URL>
"""

import argparse
import hashlib
import json
import os
import sys
from http import HTTPStatus
from typing import TYPE_CHECKING, Any

import requests

from recipes.auth import SERVICE_TOKEN_HEADER
from recipes.models import IngredientFacts, Recipe, RecipeFacts
from recipes.parse import parse_line

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping

# Recorded on each recipe enriched, so recipes enriched by an older version can be found.
ENRICHMENT_VERSION = 1
SERVICE_TOKEN_ENV = "PLATEFUL_SERVICE_TOKEN"

# Sends one request (method, URL, headers, body) and gives back its status and JSON body.
type Send = Callable[[str, str, Mapping[str, str], bytes | None], tuple[int, Any]]


def facts_for(recipe: Recipe) -> RecipeFacts:
    """A parse fact for each of the Original's lines, across all its Components."""
    return RecipeFacts(
        ingredients={
            line.id: IngredientFacts(parse=parse_line(line.text))
            for line in recipe.original.ingredients
        }
    )


def run(base_url: str, token: str, send: Send) -> int:
    """Enrich every Pending recipe, printing each one's new status. Returns how many failed."""
    auth = {SERVICE_TOKEN_HEADER: token}
    status, collection = send("GET", f"{base_url}/api/collection", auth, None)
    if status != HTTPStatus.OK:
        print(f"Couldn't list the Collection: {status} {collection}")
        return 1
    pending = [card for card in collection["cards"] if card["status"] == "pending"]
    failed = 0
    for card in pending:
        status, body = send("GET", f"{base_url}/api/recipes/{card['id']}", auth, None)
        if status == HTTPStatus.OK:
            recipe = Recipe.model_validate(body)
            enrichment = {
                "enrichment_version": ENRICHMENT_VERSION,
                "facts": facts_for(recipe).model_dump(mode="json"),
            }
            data = json.dumps(enrichment).encode()
            headers = {
                **auth,
                "content-type": "application/json",
                # CloudFront's OAC signs the request to the API with the body's SHA-256.
                "x-amz-content-sha256": hashlib.sha256(data).hexdigest(),
            }
            url = f"{base_url}/api/recipes/{recipe.id}/enrichment"
            status, body = send("PUT", url, headers, data)
        if status == HTTPStatus.OK:
            print(f"{card['title']} → {body['status']}")
        else:
            failed += 1
            print(f"{card['title']} → failed: {status} {body}")
    print(f"Enriched {len(pending) - failed} of {len(pending)} Pending recipes, {failed} failed")
    return failed


def send_with(session: requests.Session) -> Send:
    def send(
        method: str, url: str, headers: Mapping[str, str], body: bytes | None
    ) -> tuple[int, Any]:
        response = session.request(method, url, headers=headers, data=body, timeout=60)
        try:
            return response.status_code, response.json()
        except requests.JSONDecodeError:
            return response.status_code, response.text

    return send


def main() -> None:
    parser = argparse.ArgumentParser(description="Enrich every Pending recipe through the API.")
    parser.add_argument("base_url", help="the API's base URL, e.g. http://localhost:5173")
    args = parser.parse_args()
    token = os.environ.get(SERVICE_TOKEN_ENV)
    if not token:
        sys.exit(f"Set {SERVICE_TOKEN_ENV} to the stack's service token")
    with requests.Session() as session:
        failed = run(args.base_url.rstrip("/"), token, send_with(session))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
