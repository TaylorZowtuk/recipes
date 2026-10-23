"""The kill switch: an SNS message from a spend alarm throttles the stack's API to zero."""

import io
import json
import zipfile
from typing import TYPE_CHECKING

import boto3
import pytest
from moto import mock_aws

from recipes import kill_switch

if TYPE_CHECKING:
    from collections.abc import Iterator

API = "plateful-test-api"


def placeholder_zip() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr("run.sh", "#!/bin/sh\n")
    return buffer.getvalue()


@pytest.fixture
def api(monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    """A stack's API function on fake AWS, nothing reserved, and the kill switch aimed at it."""
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-west-2")
    monkeypatch.setenv("API_FUNCTION_NAME", API)
    with mock_aws():
        role = boto3.client("iam").create_role(
            RoleName=API,
            AssumeRolePolicyDocument=json.dumps({"Version": "2012-10-17", "Statement": []}),
        )
        boto3.client("lambda").create_function(
            FunctionName=API,
            Runtime="python3.14",
            Role=role["Role"]["Arn"],
            Handler="run.sh",
            Code={"ZipFile": placeholder_zip()},
        )
        yield API


def sns_event(subject: str, message: str) -> dict[str, object]:
    return {
        "Records": [
            {
                "EventSource": "aws:sns",
                "Sns": {
                    "TopicArn": "arn:aws:sns:us-east-1:123456789012:plateful-spend-alarm",
                    "Subject": subject,
                    "Message": message,
                },
            }
        ]
    }


def test_an_alarm_sets_the_api_reserved_concurrency_to_zero(api: str) -> None:
    kill_switch.handler(sns_event("ALARM: spend", '{"AlarmName": "plateful-spend"}'), None)

    concurrency = boto3.client("lambda").get_function_concurrency(FunctionName=api)
    assert concurrency["ReservedConcurrentExecutions"] == 0


def test_tripping_twice_keeps_it_at_zero(api: str) -> None:
    for _ in range(2):
        kill_switch.handler(sns_event("test", "trip"), None)

    concurrency = boto3.client("lambda").get_function_concurrency(FunctionName=api)
    assert concurrency["ReservedConcurrentExecutions"] == 0
