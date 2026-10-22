"""Serve the API on a fake, seeded stack (moto) for the Playwright end-to-end tests."""

import uvicorn


def main() -> None:
    uvicorn.run("recipes.local:app", host="127.0.0.1", port=8787)


if __name__ == "__main__":
    main()
