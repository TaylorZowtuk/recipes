"""Serve the API on fake AWS (moto) for the Playwright end-to-end tests."""

import os

import uvicorn
from moto import mock_aws


def main() -> None:
    os.environ.setdefault("AWS_DEFAULT_REGION", "ca-west-1")
    with mock_aws():
        # Seed data goes here, into moto's fake table, once the table exists.
        uvicorn.run("recipes.api:app", host="127.0.0.1", port=int(os.environ.get("PORT", "8787")))


if __name__ == "__main__":
    main()
