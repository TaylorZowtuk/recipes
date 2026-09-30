# Editors sign in with Google directly, into a stateless session cookie; visitors see a Demo instead of household plans

Editors sign in with **Sign in with Google**, verified by the API itself, and get a signed session cookie. Local CLIs use one permanent **service token** per stack. **Cognito isn't used**, even though its Essentials plan is free for two users: it adds a user pool, a hosted login and token handling, and it can't give the rolling one-year session the household wants, because its refresh tokens expire on a fixed date even with rotation. Every mechanism below costs $0 and adds no billable service. Emailed one-time codes were rejected because they need SES, which isn't in ca-west-1 and is metered. Sign in with Apple was rejected because it needs the $99/yr Apple Developer Program. This replaces the "one Cognito user pool per stack" noted when the hosting platform was chosen.

## Sign-in

- The PWA uses Google Identity Services in **popup mode**, which returns a Google ID token. A popup (`window.open`) keeps an installed iOS app from handing the flow to Safari, whose cookies are separate from the app's. There is no redirect and no client secret.
- The API verifies the ID token: its signature against Google's keys, the audience (the stack's client ID) and `email_verified`. It then checks the email against the stack's **editor allowlist**.
- The allowlist holds the household's two emails. It's kept in an SSM parameter, not in Terraform source, because the repo is public. Changing it is a config change: there is no invite UI.
- Each stack's Google OAuth client stays in **Testing** status, with the editors as its only test users. That makes Google enforce a second allowlist. With only the basic `openid email profile` scopes, Testing sign-ins don't expire after 7 days. Staging's client also allows the local dev server's origin.
- **Risk to check first:** the Google popup inside an installed iOS PWA. It is the first acceptance check in the walking skeleton.

## Session

- A **stateless HMAC-signed cookie** holds the editor's email and an expiry. It is `HttpOnly`, `Secure`, `SameSite=Strict` and scoped to `/api`.
- The signing key is a per-stack SecureString in SSM Parameter Store (Standard tier, AWS-managed key).
- The session expires **one year after last use**. The API re-issues the cookie at most once a day. The cookie is set by the server on the same CloudFront host as the page, so Safari's 7-day cap on cookies set by script doesn't apply.
- There's no session store and no device list. Sign out clears the cookie on that device. A lost phone stays signed in until it expires, and rotating the signing key signs everyone out.
- CSRF is covered by `SameSite=Strict` together with the `x-amz-content-sha256` header that every write must carry for CloudFront OAC. A cross-site form can't set that header.
- The session can't travel in `Authorization`, because CloudFront OAC replaces that header with its own SigV4 signature.

## Service token for CLIs

- The `enrich` CLI, the bulk import and `backup pull` send a **permanent service token** in a custom header. The API treats a match as an editor.
- Each stack has its own token. SSM holds only its SHA-256 hash, compared in constant time. The plaintext lives in the owner's password manager, plus a GitHub Actions secret for any unattended job. The CLI never reads it from SSM, so nothing local holds AWS credentials.
- To revoke it, write a new hash and force a cold start. Staging's token is also the Playwright end-to-end editor, so staging needs no auth bypass.
- Cognito was a poor fit for CLIs anyway: it has no device-code flow, calls loopback redirects "for testing purposes only", and its machine-to-machine tokens have no free tier.

## What visitors see

- Visitors see everything an editor sees except editing controls and review marks. That includes Recipes (with Difficulty, Tags and Our Version), Favorite Sites, Kitchen settings and Fridge.
- The household's **Week Plans and Grocery Lists are private.** Visitors get a **Demo** instead. It is generated on their device from the public collection and seeded by the current week, and it uses the same components as the real screens. It is fully interactive, never sent to the API, and resets on reload, under a "Demo — changes aren't saved" banner.
- Only the Week Plan and Grocery List endpoints need a session. They forward the cookie and are never cached. Every other read is anonymous and cached in CloudFront, with no cookie in the cache key.

## Consequences

- The API has one "is this an editor" check with two inputs: the session cookie and the service-token header. Nothing else in the codebase knows how a person signed in.
- The kill switch (reserved concurrency 0) also blocks sign-in. That's expected, since the app is read-only while it's tripped.
