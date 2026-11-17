# Away from the Week and Grocery List tabs, an idle phone polls every 5 minutes instead of every 60 s

Supersedes in part the [offline cache and sync ADR](2026-10-01-offline-cache-and-sync.md), which backs off only the 3 s poll on the Week and Grocery List tabs.

## Decision

- Away from the Week and Grocery List tabs, the phone polls `/api/sync` every 60 s while the page is visible.
- After about 5 minutes without a touch, scroll, key press or pointer movement, that poll drops to **every 5 minutes**. Any interaction brings back 60 s at once.
- The 3 s poll on the Week and Grocery List tabs, and its drop to 60 s after 5 idle minutes, stand as the offline cache ADR describes. Focus, coming back to the page and coming back online still poll at once, and a hidden page still never polls.

## Why

A browser tab or installed app left open on the Collection, say on a kitchen tablet, would otherwise poll 1,440 times a day for changes nobody is looking at. Every poll is a Lambda call against the free 1M requests a month. Nobody who hasn't touched the screen for 5 minutes needs to see another phone's change within a minute, and the first touch polls again within a minute.

## Consequences

- It only lowers how often a phone polls, so the WAF rate limit of about 1,000 requests per 5 minutes per IP is unchanged.
