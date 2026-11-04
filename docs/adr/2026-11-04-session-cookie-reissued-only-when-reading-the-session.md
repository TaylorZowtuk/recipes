# The session cookie is re-issued only when reading the session

The API re-issues a session cookie more than a day old only on `GET /api/session`. The editor check on every other route never sets a cookie.

## Why

Sign out deletes the cookie, but a `GET` answered after that `DELETE` could set it again. The screen would say signed out while the device kept a year-long session. Sign-out already waits for its own `GET /api/session`, and it can't wait for every request. The Week Plan reloads on window focus, and polling will add more requests, so that race would only widen.

## Consequences

- [Editor sign-in](2026-09-29-editor-sign-in.md) still holds: the cookie is re-issued at most once a day and expires a year after last use. Every page load reads the session, so a page load is what counts as use. An app left open for a year without a reload would expire.
- A route that checks for an editor can no longer re-issue the cookie, so that is no longer a reason to keep the check away from `/api/v/`. The rule in [versioned reads](2026-10-26-path-versioned-reads-cached-at-cloudfront.md) stands, because no cookie reaches those routes.
