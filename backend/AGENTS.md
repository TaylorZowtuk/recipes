# Backend

- Python is pinned in `.python-version` to the newest version the Lambda runtime supports.
- Ruff runs with every rule on (`select = ["ALL"]`) and pyright in strict mode. Add an ignore to `pyproject.toml` with a reason rather than scattering `noqa`.
- Tests drive the API over HTTP with FastAPI's `TestClient` and fake AWS with moto. They never touch a real stack.
- After changing an endpoint or its models, run `make api-client` and commit the regenerated client.
