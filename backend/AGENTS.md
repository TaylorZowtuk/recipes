# Backend

- Python is pinned in `.python-version` to the newest version the Lambda runtime supports.
- Ruff runs with every rule on (`select = ["ALL"]`) and pyright in strict mode. Add an ignore to `pyproject.toml` with a reason rather than scattering `noqa`.
- Tests drive the API over HTTP with FastAPI's `TestClient` and fake AWS with moto. They never touch a real stack.
- Signing in locally: under `make dev` and the local e2e tests (`recipes.local`), the editor is `editor@example.com`, a Google credential is `fake:<email>` (`fake-unverified:<email>` for an unverified one), and the service token is `local-dev-service-token` in the `x-plateful-service-token` header. Tests inject their own settings and a fake verifier through `create_app(auth=...)`.
- After changing an endpoint or its models, run `make api-client` and commit the regenerated client.
