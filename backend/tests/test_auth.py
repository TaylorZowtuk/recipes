"""Editor sign-in: Sign in with Google into a session cookie, and the service token for CLIs."""

import base64
import hashlib
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

import pytest
from fastapi.testclient import TestClient

from recipes.api import create_app
from recipes.auth import (
    SERVICE_TOKEN_HEADER,
    SESSION_COOKIE,
    Auth,
    AuthSettings,
    Claims,
    Editor,
    EditorDep,
    InvalidIdToken,
)
from recipes.store import Store

if TYPE_CHECKING:
    from collections.abc import Iterator

    from fastapi import FastAPI
    from httpx2 import Response

CLIENT_ID = "test-client.apps.googleusercontent.com"
SERVICE_TOKEN = "synthetic-service-token"
EDITOR = "editor@example.com"
T0 = datetime(2026, 10, 1, 12, tzinfo=UTC)
ONE_YEAR = 365 * 24 * 60 * 60


@dataclass
class Clock:
    now: datetime = T0

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **delta: float) -> None:
        self.now += timedelta(**delta)


def fake_verifier(token: str, audience: str) -> Claims:
    """Accepts `valid:<email>` and `unverified:<email>`, for this stack's client ID only."""
    kind, _, email = token.partition(":")
    if audience != CLIENT_ID or kind not in {"valid", "unverified"}:
        raise InvalidIdToken(token)
    return Claims(email=email, email_verified=kind == "valid")


@dataclass
class Settings:
    """The stack's settings, which a test can change as if a new value were written to SSM."""

    value: AuthSettings

    def __call__(self) -> AuthSettings:
        return self.value


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def settings() -> Settings:
    return Settings(
        AuthSettings.parse(
            {
                "editor-allowlist": " Editor@Example.com ,partner@example.com",
                "session-hmac-key": base64.b64encode(b"synthetic-session-key-for-tests!!").decode(),
                "service-token-hash": hashlib.sha256(SERVICE_TOKEN.encode()).hexdigest(),
                "google-client-id": CLIENT_ID,
            }
        )
    )


@pytest.fixture
def app(table: str, settings: Settings, clock: Clock) -> FastAPI:
    auth = Auth(settings=settings, verifier=fake_verifier, clock=clock)
    app = create_app(store=lambda: Store(table), auth=lambda: auth)

    @app.get("/api/test-editors-only")
    def editors_only(editor: EditorDep) -> Editor:  # pyright: ignore[reportUnusedFunction]
        return editor

    return app


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app, follow_redirects=False) as client:
        yield client


def set_cookie(response: Response) -> dict[str, str] | None:
    """The session cookie the response sets: its value under "", then its attributes."""
    for header in response.headers.get_list("set-cookie"):
        name_value, *attributes = header.split("; ")
        name, _, value = name_value.partition("=")
        if name == SESSION_COOKIE:
            parsed: dict[str, str] = {"": value}
            for attribute in attributes:
                key, _, val = attribute.partition("=")
                parsed[key.lower()] = val
            return parsed
    return None


def sign_in(client: TestClient, credential: str = f"valid:{EDITOR}") -> Response:
    return client.post("/api/session", json={"credential": credential})


def cookie_value(response: Response) -> str:
    cookie = set_cookie(response)
    assert cookie is not None, "expected the response to set the session cookie"
    return cookie[""]


def with_cookie(value: str) -> dict[str, str]:
    return {"Cookie": f"{SESSION_COOKIE}={value}"}


def session(client: TestClient, value: str) -> Response:
    return client.get("/api/session", headers=with_cookie(value))


# Signing in


def test_an_allowlisted_verified_email_signs_in_and_gets_the_session_cookie(
    client: TestClient,
) -> None:
    response = sign_in(client)

    assert response.status_code == 200
    assert response.json() == {"editor": True, "email": EDITOR, "google_client_id": CLIENT_ID}
    assert response.headers["Cache-Control"] == "no-store"
    cookie = set_cookie(response)
    assert cookie is not None
    assert cookie[""]
    assert {k: v for k, v in cookie.items() if k} == {
        "httponly": "",
        "secure": "",
        "samesite": "strict",
        "path": "/api",
        "max-age": str(ONE_YEAR),
    }


def test_the_allowlist_ignores_case_and_surrounding_spaces(client: TestClient) -> None:
    response = sign_in(client, "valid:PARTNER@example.COM")
    assert response.status_code == 200
    assert response.json()["email"] == "partner@example.com"


def test_an_unverified_email_is_refused(client: TestClient) -> None:
    response = sign_in(client, f"unverified:{EDITOR}")
    assert response.status_code == 403
    assert set_cookie(response) is None


def test_an_email_not_on_the_allowlist_is_refused(client: TestClient) -> None:
    response = sign_in(client, "valid:stranger@example.com")
    assert response.status_code == 403
    assert set_cookie(response) is None


def test_an_invalid_id_token_is_refused(client: TestClient) -> None:
    response = sign_in(client, "forged")
    assert response.status_code == 401
    assert set_cookie(response) is None


def test_sign_in_says_it_isnt_configured_without_a_client_id(
    client: TestClient, settings: Settings
) -> None:
    settings.value = replace(settings.value, google_client_id=None)

    response = sign_in(client)

    assert response.status_code == 503
    assert response.json() == {"detail": "Sign-in isn't configured"}
    assert client.get("/api/session").json()["google_client_id"] is None


def test_sign_in_says_it_isnt_configured_without_a_signing_key(
    client: TestClient, settings: Settings
) -> None:
    settings.value = replace(settings.value, session_key=None)
    assert sign_in(client).status_code == 503


# The session


def test_a_visitor_has_no_session(client: TestClient) -> None:
    response = client.get("/api/session")
    assert response.status_code == 200
    assert response.json() == {"editor": False, "email": None, "google_client_id": CLIENT_ID}
    assert response.headers["Cache-Control"] == "no-store"
    assert set_cookie(response) is None


def test_the_session_cookie_makes_an_editor(client: TestClient) -> None:
    value = cookie_value(sign_in(client))
    response = session(client, value)
    assert response.json() == {"editor": True, "email": EDITOR, "google_client_id": CLIENT_ID}


def test_a_tampered_cookie_is_a_visitor(client: TestClient) -> None:
    value = cookie_value(sign_in(client))
    payload, _, signature = value.partition(".")
    tampered = [
        payload[:-1] + ("A" if payload[-1] != "A" else "B") + "." + signature,
        payload + "." + signature[:-1] + ("A" if signature[-1] != "A" else "B"),
        payload,
        "",
        "not.base64!.at-all",
    ]
    for bad in tampered:
        assert session(client, bad).json()["editor"] is False, bad


def test_a_cookie_signed_with_another_key_is_a_visitor(
    client: TestClient, settings: Settings
) -> None:
    value = cookie_value(sign_in(client))
    settings.value = replace(settings.value, session_key=b"another-synthetic-key-32-bytes!!")
    assert session(client, value).json()["editor"] is False


def test_a_cookie_is_good_for_a_year_after_it_was_issued(client: TestClient, clock: Clock) -> None:
    value = cookie_value(sign_in(client))

    clock.advance(days=365)
    assert session(client, value).json()["editor"] is True

    clock.advance(seconds=1)
    assert session(client, value).json()["editor"] is False


def test_a_cookie_less_than_a_day_old_is_not_reissued(client: TestClient, clock: Clock) -> None:
    value = cookie_value(sign_in(client))
    clock.advance(hours=23, minutes=59)
    response = session(client, value)
    assert response.json()["editor"] is True
    assert set_cookie(response) is None


def test_a_cookie_more_than_a_day_old_is_reissued_for_another_year(
    client: TestClient, clock: Clock
) -> None:
    first = cookie_value(sign_in(client))
    clock.advance(days=2)

    response = session(client, first)

    assert response.json()["editor"] is True
    second = cookie_value(response)
    assert second != first
    assert set_cookie(response) == set_cookie(sign_in(client)), "same attributes as at sign-in"

    clock.advance(days=364)
    assert session(client, first).json()["editor"] is False
    assert session(client, second).json()["editor"] is True


def test_a_cookie_for_an_email_taken_off_the_allowlist_is_a_visitor(
    client: TestClient, settings: Settings
) -> None:
    value = cookie_value(sign_in(client))
    settings.value = replace(settings.value, editors=frozenset({"partner@example.com"}))
    response = session(client, value)
    assert response.json()["editor"] is False
    assert set_cookie(response) is None


def test_signing_out_clears_the_cookie(client: TestClient) -> None:
    response = client.delete("/api/session")
    assert response.status_code == 204
    cookie = set_cookie(response)
    assert cookie is not None
    assert cookie[""] in {"", '""'}
    assert cookie["max-age"] == "0"
    assert cookie["path"] == "/api"


# The service token


def test_the_service_token_makes_an_editor(client: TestClient) -> None:
    response = client.get("/api/session", headers={SERVICE_TOKEN_HEADER: SERVICE_TOKEN})
    assert response.json() == {"editor": True, "email": None, "google_client_id": CLIENT_ID}
    assert set_cookie(response) is None
    assert client.get(
        "/api/test-editors-only", headers={SERVICE_TOKEN_HEADER: SERVICE_TOKEN}
    ).json() == {"name": "service-token", "email": None}


def test_a_wrong_service_token_is_a_visitor(client: TestClient) -> None:
    for wrong in ("synthetic-service-tokem", "", SERVICE_TOKEN.upper()):
        headers = {SERVICE_TOKEN_HEADER: wrong}
        assert client.get("/api/session", headers=headers).json()["editor"] is False


def test_no_service_token_matches_an_unset_hash(client: TestClient, settings: Settings) -> None:
    settings.value = replace(settings.value, service_token_hash=None)
    headers = {SERVICE_TOKEN_HEADER: SERVICE_TOKEN}
    assert client.get("/api/session", headers=headers).json()["editor"] is False


# EditorDep


def test_editor_only_routes_refuse_visitors(client: TestClient) -> None:
    response = client.get("/api/test-editors-only")
    assert response.status_code == 403
    assert response.headers["Cache-Control"] == "no-store"


def test_editor_only_routes_serve_a_signed_in_editor(client: TestClient) -> None:
    value = cookie_value(sign_in(client))
    response = client.get("/api/test-editors-only", headers=with_cookie(value))
    assert response.status_code == 200
    assert response.json() == {"name": EDITOR, "email": EDITOR}
