"""Print the API's OpenAPI schema, which the frontend's TypeScript client is generated from."""

import json

from recipes.api import app


def main() -> None:
    print(json.dumps(app.openapi(), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
