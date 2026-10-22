"""The kill switch: subscribed to the spend alarm's SNS topics, it sets the stack's API reserved
concurrency to 0. Lambda then throttles every API call, the phones show "Editing is paused." and
the PWA and images keep serving from S3. Someone re-enables the API by hand.

It runs from the API's own zip with a plain Python handler, without the Lambda Web Adapter.
"""

import logging
import os
from typing import TYPE_CHECKING, Any

import boto3

if TYPE_CHECKING:
    from types_boto3_lambda import LambdaClient

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


def handler(event: dict[str, Any], _context: object) -> None:
    function_name = os.environ["API_FUNCTION_NAME"]
    for record in event.get("Records", []):
        sns = record.get("Sns", {})
        logger.info(
            "Tripped by %s: %s: %.200s", sns.get("TopicArn"), sns.get("Subject"), sns.get("Message")
        )
    client: LambdaClient = boto3.client("lambda")
    client.put_function_concurrency(FunctionName=function_name, ReservedConcurrentExecutions=0)
    logger.info("Set %s reserved concurrency to 0", function_name)
