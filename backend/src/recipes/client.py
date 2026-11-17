"""The CLIs' way to a stack's API: signed in with the service token, which never leaves the API's
origin.
"""

import hashlib
import sys
from typing import TYPE_CHECKING, Any
from urllib.parse import urljoin, urlsplit

import requests

from recipes.auth import SERVICE_TOKEN_HEADER

if TYPE_CHECKING:
    from collections.abc import Callable

SERVICE_TOKEN_ENV = "PLATEFUL_SERVICE_TOKEN"
# Hosts a base URL may name over plain http: make dev's, from the host or from make shell.
LOCAL_HOSTS = {"localhost", "127.0.0.1", "api"}

# Sends one request (method, URL, body), signed in, and gives back its status and JSON body.
type Send = Callable[[str, str, bytes | None], tuple[int, Any]]


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
