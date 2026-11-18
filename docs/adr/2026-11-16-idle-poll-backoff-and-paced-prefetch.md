# An idle phone polls every 5 minutes away from the Week and Grocery List tabs, and the prefetch sends one request a second

Supersedes in part the [offline cache and sync ADR](2026-10-01-offline-cache-and-sync.md), which backs off only the 3 s poll on the Week and Grocery List tabs and doesn't pace the prefetch.

## Decision

- Away from the Week and Grocery List tabs, the phone polls `/api/sync` every 60 s while the page is visible.
- After about 5 minutes without a touch, scroll, key press or pointer movement, that poll drops to **every 5 minutes**. Any interaction brings back 60 s at once.
- The 3 s poll on the Week and Grocery List tabs, and its drop to 60 s after 5 idle minutes, stand as the offline cache ADR describes. Focus, coming back to the page and coming back online still poll at once, and a hidden page still never polls.
- The prefetch sends **about one request a second**: a recipe or card-size image already cached costs nothing, and each one it fetches waits about 1 s after the last. It sends nothing while the page is hidden. What a screen asks for (the bundle for the grid, a recipe or photo being opened) is never paced or queued behind it.

## Why

A browser tab or installed app left open on the Collection, say on a kitchen tablet, would otherwise poll 1,440 times a day for changes nobody is looking at. Every poll is a Lambda call against the free 1M requests a month. Nobody who hasn't touched the screen for 5 minutes needs to see another phone's change within a minute, and the first touch polls again within a minute.

A full prefetch fetches one recipe and one card-size image per card. At the [about 500 recipes](2026-09-26-aws-hosting-fastapi-react.md) the hosting plans for, that's about 1,000 requests, and the WAF lets each IP make about 1,000 per 5 minutes, CloudFront cache hits included. After a schema change every phone on the home Wi-Fi refills at once, which unpaced could lock the household out. At one a second each phone sends about 300 per 5 minutes, so two phones refilling together, plus their polls, stay well under the limit.

## Consequences

- The idle backoff only lowers how often a phone polls, so the WAF rate limit of about 1,000 requests per 5 minutes per IP is unchanged.
- A full refill of 500 recipes takes about 17 minutes in the background. Until it finishes, a recipe not yet cached needs the network.

## Considered and rejected

- **Exempting `GET /api/v/*` and `/images/*` from the WAF rule**, so the prefetch could run unpaced. Requests for versions CloudFront hasn't cached would then reach Lambda with no limit, weakening the spend guard.
