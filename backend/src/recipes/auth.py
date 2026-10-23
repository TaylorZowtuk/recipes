"""Who is an editor. The only module that knows how someone signed in.

Editors sign in with Google into a stateless, HMAC-signed session cookie; CLIs send the stack's
service token in a header (docs/adr/2026-09-29-editor-sign-in.md). Routes ask one question,
through `CurrentEditor` or `EditorDep`, and never read the cookie or the header themselves.
"""

import base64
import binascii
import functools
import hashlib
import hmac
import logging
import os
import threading
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Annotated, Protocol

import boto3
import requests
from botocore.config import Config
from cachecontrol import CacheControl
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from google.auth.exceptions import GoogleAuthError, TransportError
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2 import id_token
from pydantic import BaseModel

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping

    from google.auth.transport import Request as Transport
    from types_boto3_ssm import SSMClient

SESSION_COOKIE = "plateful_session"
SERVICE_TOKEN_HEADER = "x-plateful-service-token"
SERVICE_TOKEN_EDITOR = "service-token"
SESSION_LIFETIME = timedelta(days=365)
REISSUE_AFTER = timedelta(days=1)
# How far ahead of the API's clock a cookie's issued-at may be, for a clock that has moved back.
CLOCK_SKEW = timedelta(minutes=5)
MIN_KEY_BYTES = 32
# The SSM parameters under the stack's SSM_PREFIX, and the value Terraform first writes to them.
PARAMETERS = ("editor-allowlist", "session-hmac-key", "service-token-hash", "google-client-id")
PLACEHOLDER = "placeholder"
UNCONFIGURED = "Sign-in isn't configured"
# How long the API keeps the SSM settings before reading them again.
SETTINGS_TTL = timedelta(minutes=5)
# Well inside the Lambda's 30 s timeout, so a hung SSM or Google answers 503 rather than dying.
_SSM_CONFIG = Config(connect_timeout=3, read_timeout=5, retries={"max_attempts": 2})
GOOGLE_TIMEOUT_SECONDS = 5
# Signed along with the payload, so a signature for anything else never passes as a session.
_SESSION_CONTEXT = b"plateful-session-v1."

logger = logging.getLogger(__name__)


class Editor(BaseModel):
    """Who is editing: the signed-in email, or the service token's name with no email."""

    name: str
    email: str | None


class Session(BaseModel):
    """Whether this device is signed in, and the Google client ID the PWA signs in with."""

    editor: bool
    email: str | None
    google_client_id: str | None


class SignIn(BaseModel):
    """A Google ID token from Sign in with Google."""

    credential: str


@dataclass(frozen=True)
class Claims:
    """What sign-in needs from a verified Google ID token."""

    email: str
    email_verified: bool


class InvalidIdToken(Exception):
    """The ID token wasn't signed by Google for this stack's client, or has expired."""


class SignInUnavailable(Exception):
    """Sign-in can't be checked right now, such as when Google's keys can't be fetched."""


class IdTokenVerifier(Protocol):
    def __call__(self, token: str, audience: str) -> Claims:
        """The token's claims once verified for `audience`, or raises InvalidIdToken."""
        ...


@dataclass(frozen=True)
class AuthSettings:
    """A stack's sign-in settings. Anything unset or still a placeholder signs no one in."""

    editors: frozenset[str]
    session_key: bytes | None
    service_token_hash: str | None
    google_client_id: str | None

    @classmethod
    def parse(cls, values: Mapping[str, str]) -> AuthSettings:
        """Settings from the SSM parameters' values, by name without the prefix."""
        editors = frozenset(
            normalize_email(email)
            for email in values.get("editor-allowlist", "").split(",")
            if "@" in email
        )
        token_hash = values.get("service-token-hash", "").strip().lower()
        client_id = values.get("google-client-id", "").strip()
        return cls(
            editors=editors,
            session_key=_session_key(values.get("session-hmac-key", "")),
            service_token_hash=token_hash if _is_sha256_hex(token_hash) else None,
            google_client_id=None
            if not client_id or client_id.startswith(PLACEHOLDER)
            else client_id,
        )


def normalize_email(email: str) -> str:
    return email.strip().lower()


def _session_key(value: str) -> bytes | None:
    try:
        key = base64.b64decode(value.strip(), validate=True)
    except binascii.Error, ValueError:
        return None
    return key if len(key) >= MIN_KEY_BYTES else None


def _is_sha256_hex(value: str) -> bool:
    return len(value) == hashlib.sha256().digest_size * 2 and all(
        c in "0123456789abcdef" for c in value
    )


def ssm_settings(
    prefix: str, client: SSMClient | None = None, clock: Callable[[], float] = time.monotonic
) -> Callable[[], AuthSettings]:
    """The settings under `prefix`, read with one call when first needed and kept for
    SETTINGS_TTL, so a new value takes effect within five minutes. When a read after that fails,
    the last good settings stay in use and the next request tries again: a passing SSM error
    shouldn't sign anyone out. Only a failed first read raises.
    """
    lock = threading.Lock()
    ssm: list[SSMClient] = [client] if client else []
    loaded: list[tuple[AuthSettings, float]] = []

    def fetch() -> AuthSettings:
        if not ssm:
            ssm.append(boto3.client("ssm", config=_SSM_CONFIG))
        response = ssm[0].get_parameters(
            Names=[prefix + name for name in PARAMETERS], WithDecryption=True
        )
        return AuthSettings.parse(
            {
                p["Name"].removeprefix(prefix): p["Value"]
                for p in response["Parameters"]
                if "Name" in p and "Value" in p
            }
        )

    def settings() -> AuthSettings:
        with lock:
            now = clock()
            if loaded and now - loaded[0][1] < SETTINGS_TTL.total_seconds():
                return loaded[0][0]
            try:
                fresh = fetch()
            except Exception:
                if not loaded:
                    raise
                logger.exception("Sign-in settings not refreshed: keeping the last good ones")
                return loaded[0][0]
            loaded[:] = [(fresh, now)]
            return fresh

    return settings


class GoogleVerifier:
    """Verifies Google ID tokens: Google's signature, this client's audience, Google's issuer and
    the expiry. Google's signing certs are kept for as long as their Cache-Control allows.
    """

    def __init__(self, request: Transport | Callable[..., object] | None = None) -> None:
        self.request = request or functools.partial(
            GoogleRequest(session=CacheControl(requests.Session())),
            timeout=GOOGLE_TIMEOUT_SECONDS,
        )

    def __call__(self, token: str, audience: str) -> Claims:
        try:
            info = id_token.verify_oauth2_token(  # pyright: ignore[reportUnknownMemberType]
                token, self.request, audience, clock_skew_in_seconds=10
            )
        except TransportError as e:
            msg = "Google can't be reached: try again later"
            raise SignInUnavailable(msg) from e
        except (ValueError, GoogleAuthError) as e:
            raise InvalidIdToken from e
        email: object = info.get("email")
        if not isinstance(email, str):
            msg = "The ID token has no email"
            raise InvalidIdToken(msg)
        return Claims(email=email, email_verified=info.get("email_verified") is True)


def _now() -> datetime:
    return datetime.now(UTC)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


@dataclass(frozen=True)
class Auth:
    """Sign-in for one stack: its settings, how Google ID tokens are verified, and the clock."""

    settings: Callable[[], AuthSettings]
    verifier: IdTokenVerifier
    clock: Callable[[], datetime] = _now
    # Only the local fake stack turns this off, for browsers that refuse Secure cookies over http.
    secure_cookie: bool = True

    @classmethod
    def from_env(cls) -> Auth:
        """The deployed stack's: settings from SSM under SSM_PREFIX, checked with Google."""
        return cls(settings=ssm_settings(os.environ["SSM_PREFIX"]), verifier=GoogleVerifier())

    def editor(
        self, cookie: str | None, service_token: str | None, response: Response
    ) -> Editor | None:
        """The editor the request's cookie or service token names, or None for a visitor. A session
        more than a day old is re-issued on `response`, so it lasts a year after last use.
        """
        if not cookie and not service_token:
            return None  # a visitor, without reading the settings
        settings = self.settings()
        if service_token and _service_token_matches(service_token, settings):
            return Editor(name=SERVICE_TOKEN_EDITOR, email=None)
        if not cookie:
            return None
        session = self._read_session(cookie, settings)
        if session is None:
            return None
        email, issued_at = session
        if self.clock() - issued_at > REISSUE_AFTER:
            self._set_session(response, email, settings)
        return Editor(name=email, email=email)

    def sign_in(self, credential: str, response: Response) -> Editor:
        settings = self.settings()
        if settings.google_client_id is None or settings.session_key is None:
            raise SignInUnavailable(UNCONFIGURED)
        claims = self.verifier(credential, settings.google_client_id)
        email = normalize_email(claims.email)
        if not claims.email_verified or email not in settings.editors:
            raise NotAnEditor
        self._set_session(response, email, settings)
        return Editor(name=email, email=email)

    def sign_out(self, response: Response) -> None:
        response.delete_cookie(
            SESSION_COOKIE,
            path="/api",
            secure=self.secure_cookie,
            httponly=True,
            samesite="strict",
        )

    def _set_session(self, response: Response, email: str, settings: AuthSettings) -> None:
        key = settings.session_key
        if key is None:
            raise SignInUnavailable(UNCONFIGURED)
        issued_at = int(self.clock().timestamp())
        payload = _b64(_SessionPayload(email=email, iat=issued_at).model_dump_json().encode())
        response.set_cookie(
            SESSION_COOKIE,
            f"{payload}.{_sign(key, payload)}",
            max_age=int(SESSION_LIFETIME.total_seconds()),
            path="/api",
            secure=self.secure_cookie,
            httponly=True,
            samesite="strict",
        )

    def _read_session(self, cookie: str, settings: AuthSettings) -> tuple[str, datetime] | None:
        """The cookie's email and issued-at, if it's signed with this stack's key, unexpired and
        for an email still on the allowlist.
        """
        if settings.session_key is None:
            return None
        payload = _verified_payload(settings.session_key, cookie)
        if payload is None or payload.email not in settings.editors:
            return None
        issued_at = datetime.fromtimestamp(payload.iat, UTC)
        now = self.clock()
        if not now - SESSION_LIFETIME <= issued_at <= now + CLOCK_SKEW:
            return None
        return payload.email, issued_at


class _SessionPayload(BaseModel):
    email: str
    iat: int  # issued at, in seconds since the epoch


def _verified_payload(key: bytes, cookie: str) -> _SessionPayload | None:
    """The cookie's payload, if `key` signed it."""
    payload, dot, signature = cookie.partition(".")
    if not dot or not hmac.compare_digest(_sign(key, payload).encode(), signature.encode()):
        return None
    try:
        return _SessionPayload.model_validate_json(_unb64(payload), strict=True)
    except binascii.Error, ValueError:  # pydantic's ValidationError is a ValueError
        return None


class NotAnEditor(Exception):
    """A real Google account, but unverified or not on the stack's editor allowlist."""


def _sign(key: bytes, payload: str) -> str:
    return _b64(hmac.new(key, _SESSION_CONTEXT + payload.encode(), hashlib.sha256).digest())


def _service_token_matches(token: str, settings: AuthSettings) -> bool:
    if settings.service_token_hash is None:
        return False
    presented = hashlib.sha256(token.encode()).hexdigest()
    return hmac.compare_digest(presented.encode(), settings.service_token_hash.encode())


# Dependencies and routes


def _auth(request: Request) -> Auth:
    return request.app.state.auth


AuthDep = Annotated[Auth, Depends(_auth)]


def current_editor(request: Request, response: Response, auth: AuthDep) -> Editor | None:
    return auth.editor(
        request.cookies.get(SESSION_COOKIE), request.headers.get(SERVICE_TOKEN_HEADER), response
    )


CurrentEditor = Annotated[Editor | None, Depends(current_editor)]
"""The editor making the request, or None for a visitor. Routes using it are never cached."""


def require_editor(editor: CurrentEditor) -> Editor:
    if editor is None:
        raise HTTPException(403, "Only an editor can do that")
    return editor


EditorDep = Annotated[Editor, Depends(require_editor)]
"""The editor making the request; a visitor gets a 403."""

router = APIRouter(prefix="/api")
NO_STORE = "no-store"


@router.get("/session")
def get_session(editor: CurrentEditor, auth: AuthDep, response: Response) -> Session:
    response.headers["Cache-Control"] = NO_STORE
    return Session(
        editor=editor is not None,
        email=None if editor is None else editor.email,
        google_client_id=auth.settings().google_client_id,
    )


@router.post(
    "/session",
    responses={
        401: {"description": "Not a valid Google ID token for this stack"},
        403: {"description": "Unverified, or not on the editor allowlist"},
        503: {"description": "Sign-in isn't configured, or Google can't be reached"},
    },
)
def post_session(body: SignIn, auth: AuthDep, response: Response) -> Session:
    """Sign in with a Google ID token, which sets the session cookie."""
    response.headers["Cache-Control"] = NO_STORE
    try:
        editor = auth.sign_in(body.credential, response)
    except InvalidIdToken:
        raise HTTPException(401, "Sign-in failed: try again") from None
    except NotAnEditor:
        raise HTTPException(403, "That Google account isn't an editor here") from None
    except SignInUnavailable as e:
        raise HTTPException(503, str(e)) from None
    return Session(
        editor=True, email=editor.email, google_client_id=auth.settings().google_client_id
    )


@router.delete("/session", status_code=204)
def delete_session(auth: AuthDep, response: Response) -> None:
    """Sign out on this device."""
    auth.sign_out(response)
