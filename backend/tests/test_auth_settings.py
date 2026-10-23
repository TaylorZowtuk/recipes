"""Where sign-in's settings and Google's verdict come from: SSM, and Google's signing keys."""

import base64
import hashlib
import json
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any, cast

import boto3
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from google.auth import crypt, jwt
from moto import mock_aws

from recipes.auth import AuthSettings, GoogleVerifier, InvalidIdToken, ssm_settings

if TYPE_CHECKING:
    from collections.abc import Iterator

    from types_boto3_ssm import SSMClient

PREFIX = "/plateful/test/"
KEY = base64.b64encode(b"k" * 32).decode()
TOKEN_HASH = hashlib.sha256(b"synthetic-service-token").hexdigest()


@dataclass
class CountingSsm:
    """moto's SSM, counting the API's calls to it."""

    client: Any
    calls: list[dict[str, Any]] = field(default_factory=list[dict[str, Any]])

    def get_parameters(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        return self.client.get_parameters(**kwargs)


@pytest.fixture
def ssm(monkeypatch: pytest.MonkeyPatch) -> Iterator[CountingSsm]:
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-west-2")
    with mock_aws():
        yield CountingSsm(boto3.client("ssm"))


def put(ssm: CountingSsm, values: dict[str, str]) -> None:
    for name, value in values.items():
        ssm.client.put_parameter(Name=PREFIX + name, Value=value, Type="SecureString")


def test_settings_are_read_from_ssm_once_on_first_need(ssm: CountingSsm) -> None:
    put(
        ssm,
        {
            "editor-allowlist": "Editor@Example.com, partner@example.com",
            "session-hmac-key": KEY,
            "service-token-hash": TOKEN_HASH.upper(),
            "google-client-id": "stack-client.apps.googleusercontent.com",
        },
    )

    settings = ssm_settings(PREFIX, cast("SSMClient", ssm))
    assert ssm.calls == [], "nothing is read until sign-in needs it"

    first = settings()
    second = settings()

    assert first is second
    assert len(ssm.calls) == 1
    assert ssm.calls[0]["WithDecryption"] is True
    assert sorted(ssm.calls[0]["Names"]) == sorted(
        PREFIX + n
        for n in ("editor-allowlist", "session-hmac-key", "service-token-hash", "google-client-id")
    )
    assert first == AuthSettings(
        editors=frozenset({"editor@example.com", "partner@example.com"}),
        session_key=b"k" * 32,
        service_token_hash=TOKEN_HASH,
        google_client_id="stack-client.apps.googleusercontent.com",
    )


def test_placeholders_and_missing_parameters_leave_sign_in_unconfigured(ssm: CountingSsm) -> None:
    placeholder = "placeholder-set-by-hand"
    put(
        ssm,
        {
            "editor-allowlist": placeholder,
            "session-hmac-key": placeholder,
            "service-token-hash": placeholder,
        },
    )

    assert ssm_settings(PREFIX, cast("SSMClient", ssm))() == AuthSettings(
        editors=frozenset(), session_key=None, service_token_hash=None, google_client_id=None
    )


def test_a_signing_key_shorter_than_32_bytes_is_unset() -> None:
    short = base64.b64encode(b"k" * 31).decode()
    assert AuthSettings.parse({"session-hmac-key": short}).session_key is None


# Google's ID tokens, signed by a key made up for the test and served as Google serves its certs.

AUDIENCE = "stack-client.apps.googleusercontent.com"


@dataclass
class FakeResponse:
    status: int
    data: bytes
    headers: dict[str, str] = field(default_factory=dict[str, str])


@dataclass
class FakeGoogle:
    """Google's cert endpoint, as google-auth's transport request sees it."""

    signer: crypt.RSASigner
    certs: dict[str, str]
    fetches: int = 0

    def __call__(self, url: str, method: str = "GET", **_kwargs: Any) -> FakeResponse:
        assert url.startswith("https://www.googleapis.com/")
        assert method == "GET"
        self.fetches += 1
        return FakeResponse(200, json.dumps(self.certs).encode())

    def token(self, **claims: Any) -> str:
        now = int(time.time())
        payload = {
            "iss": "https://accounts.google.com",
            "aud": AUDIENCE,
            "sub": "1234567890",
            "email": "editor@example.com",
            "email_verified": True,
            "iat": now,
            "exp": now + 3600,
            **claims,
        }
        return jwt.encode(self.signer, payload).decode()  # pyright: ignore[reportUnknownMemberType]


@pytest.fixture(scope="module")
def google() -> FakeGoogle:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "synthetic")])
    now = datetime.now(UTC)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(1)
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=1))
        .sign(key, hashes.SHA256())
    )
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    signer = crypt.RSASigner.from_string(pem, key_id="kid-1")  # pyright: ignore[reportUnknownMemberType]
    return FakeGoogle(signer, {"kid-1": cert.public_bytes(serialization.Encoding.PEM).decode()})


def test_google_verifier_accepts_a_token_google_signed_for_this_client(google: FakeGoogle) -> None:
    verify = GoogleVerifier(google)
    claims = verify(google.token(email="Editor@Example.com"), AUDIENCE)
    assert claims.email == "Editor@Example.com"
    assert claims.email_verified is True
    assert verify(google.token(email_verified=False), AUDIENCE).email_verified is False


@pytest.mark.parametrize(
    "claims",
    [
        {"aud": "another-client.apps.googleusercontent.com"},
        {"iss": "https://evil.example.com"},
        {"exp": int(time.time()) - 3600, "iat": int(time.time()) - 7200},
        {"email": None},
    ],
)
def test_google_verifier_refuses_a_token_not_for_this_client(
    google: FakeGoogle, claims: dict[str, Any]
) -> None:
    with pytest.raises(InvalidIdToken):
        GoogleVerifier(google)(google.token(**claims), AUDIENCE)


def test_google_verifier_refuses_a_forged_or_garbled_token(google: FakeGoogle) -> None:
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = other.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    signer = crypt.RSASigner.from_string(pem, key_id="kid-1")  # pyright: ignore[reportUnknownMemberType]
    forger = FakeGoogle(signer, google.certs)
    for token in (forger.token(), "not-a-jwt", ""):
        with pytest.raises(InvalidIdToken):
            GoogleVerifier(google)(token, AUDIENCE)
