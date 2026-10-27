# Versioned reads put every part of their key in the path, under `/api/v/`, and CloudFront caches them there

Versioned reads live under one prefix, with every part of the cache key in the path: `GET /api/v/collection/<collection_version>` and `GET /api/v/recipes/<recipe_id>/<recipe_version>/<schema_version>`. One CloudFront behaviour, `/api/v/*`, caches them on the managed **`CachingOptimized`** policy. This replaces the `/api/collection?v=<n>` URL in the [offline cache and sync ADR](2026-10-01-offline-cache-and-sync.md), and the recipe reads' `v` and `s` query parameters; the rest of that decision stands.

## Why not a query string

- The Free plan allows only managed cache policies, and custom ones stay out of scope.
- The managed policies that put all query strings in the cache key are `UseOriginCacheControlHeaders-QueryStrings` and the Amplify ones. The first also keys on `Host` and every cookie. A header in the cache key is forwarded to the origin, and a Lambda function URL rejects the distribution's host: the CloudFront console greys the policy out for our API origin ("Lambda Function URL origins expect the origin's host and cannot resolve the distribution's host"), checked on staging on 2026-10-20. AWS says the Amplify policies are for Amplify only, and they key on `Host` or cookies too.
- So with the version in a query string, `/api/*` had to stay on `CachingDisabled`, and every phone's first fetch of a new version reached Lambda and DynamoDB.

## The behaviour

- `/api/v/*` sits before `/api/*`, targets the API origin and allows only GET and HEAD. `CachingOptimized` puts no query strings, headers or cookies in the key (only the normalised `Accept-Encoding`) and honours the origin's `max-age`, so an `immutable` read stays at the edge for up to a year.
- It has **no origin request policy**. No cookie or viewer `Host` reaches Lambda, so a cached response can't depend on who asked, and the function URL gets its own host.
- It keeps the security response headers policy and the `noindex` viewer-response function that `/api/*` has.
- With `/api/*`, `/images/*` and the default, that is 4 behaviours, within the Free plan's 5. One prefix covers the Collection and recipes, so the 5th stays free.

## Same for everyone

- Every versioned read is the same for an editor and a visitor, as [editor sign-in](2026-09-29-editor-sign-in.md) requires of every read outside the Week Plan and Grocery List.
- No route under `/api/v/` may check for an editor. No cookie reaches one, so it would take every viewer for a visitor, and a route that checks can re-issue the session cookie, which must never sit behind a cache. Anything per-user stays under the uncached `/api/*`.

## Consequences

- A versioned read answers `immutable` when its versions are current. When they aren't, it answers a `no-store` 307 to the current path; an unknown recipe is a `no-store` 404.
- `CachingOptimized` has a 1 s minimum TTL, which CloudFront applies even over `no-store`. A 307, 404 or 5xx under `/api/v/*` may be served from one edge for up to 1 s. This is accepted: a phone that follows a stale redirect lands on a version at most a second old, and its next poll catches up.
- The unversioned entry points, `GET /api/collection` and `GET /api/recipes/<recipe_id>`, stay under the uncached `/api/*` and 307 (`no-store`) to the current versioned path.
- `make smoke` checks that the second fetch of the current Collection version is a CloudFront cache hit.
