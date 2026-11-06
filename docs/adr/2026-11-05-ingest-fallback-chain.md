# The CLI turns a Queued Ingest into a recipe through a browser, recipe-scrapers and a model, and an editor pastes only HTML

This settles what the [website ingest ADR](2026-10-24-website-ingest.md) left to [TaylorZowtuk/recipes#50](https://github.com/TaylorZowtuk/recipes/issues/50): how a Queued Ingest becomes a recipe, what the local fallback tries, and what an editor can paste. Everything else in that ADR stands.

The fallback runs in the local CLI, never in the API, as that ADR says. The API gains three endpoints, and a new module, `recipes.fallback`, runs the chain. The bulk import shares that module.

## A Queued Ingest becomes a recipe in one transaction

`POST /api/queued-ingests/{ingest_id}/recipe` takes a new recipe (its Source, Original, images and preview) and in one transaction deletes the Queued Ingest, repoints the Source Guard from the Queued Ingest to the recipe, and adds the recipe with its card. Of two saves of one Queued Ingest, only the first writes: the second gets a 409. A body whose Source isn't the Queued Ingest's is a 422. The recipe is Pending enrichment, and its Ingest Channel stays *Add a recipe*: the fallback is another way of finishing an Add a recipe, not a new channel.

The other two endpoints:

- `POST /api/queued-ingests/{ingest_id}/needs-page {reason}` leaves a waiting Queued Ingest for an editor, every automated step having failed for `reason`. One that already needs its page stays as it is.
- `POST /api/queued-ingests/{ingest_id}/pasted-page {html}` captures a recipe from the HTML an editor pasted, scraped as the site the Source is on, and stores nothing. It returns what `POST /api/ingest` returns, with `extractor` set to `pasted-page`. The editor reviews it and saves it through the first endpoint. A page over the size limit is a 413, and one with no recipe is a 422.

An editor pastes the page's HTML only, never its text. The list in Add a recipe is now called "Waiting to be added".

## The chain

`python -m recipes.fallback run` takes each waiting website Queued Ingest through these steps, and stops at the first that gives a recipe:

1. **A browser.** Headless Chromium loads the page as Plateful, running its scripts.
2. **recipe-scrapers**, on the HTML the browser loaded. A recipe it reads is saved with `extractor` `playwright+recipe-scrapers`, with its Candidate Photos stored (a photo that fails to store is dropped).
3. **A model.** A page that loaded with no recipe recipe-scrapers can read goes into a Work Packet as its visible text. A model answers the packet, and `python -m recipes.fallback apply` checks each answer against the packet before saving it with `extractor` `llm`. An answer of null, or one that fails the check, marks the Queued Ingest as needing its page, reason `no_recipe`.
4. **Needs its page.** Whatever the chain can't read is marked `needs_page` with the reason it stopped, for an editor to paste. A page that loaded with no text at all is `no_recipe`.

A saved `pasted-page` Original comes from the editor's paste, not from the CLI.

The page's text goes into the packet and nowhere else: the CLI writes no file, and the packet goes to stdout. The model's answer is untrusted data, so it is checked against the page. The title, each ingredient line and each step must appear in the page's text word for word (whitespace aside), the Original must have ingredients, and no two lines may share an id. The extractor is `llm` whatever the answer says.

**An `llm` Original always stops at Awaiting Review.** A bulk import normally skips review and goes straight to Ready. It doesn't for an `llm` Original, because a model's reading is the one extraction no rule of the code produced, so an editor checks it.

## The browser's fetch policy

It is the plain fetch's policy, held at the browser's network layer.

- **robots.txt** is checked for the page, for each redirect hop and for each navigation the page makes. It isn't checked for subresources.
- **Images, media and fonts** are aborted, as a recipe isn't read from them.
- **Every request must reach a public address.** A subresource that doesn't is dropped. A page or navigation that doesn't stops the fetch with reason `blocked`.
- **Frames, popups, service workers, Workers and WebSockets are shut off.** A frame or popup runs out of sight of the guard that checks each request. Service workers are blocked in the context. The page's `Worker`, `SharedWorker`, `WebSocket`, `WebTransport` and `RTCPeerConnection` are deleted before its scripts run, because they could open requests the guard never sees, and a worker could open any other from a scope the script doesn't run in.
- **The deadline** is 30 s for the whole fetch, with 5 s of it for the page's scripts to go quiet. A page that never does is read as it stands.

We use Chrome's Fetch domain, not Playwright routes, because a Playwright route fires only for the first request of a redirect chain. It can't check a hop. The Fetch domain pauses every request, each hop included, before it leaves the browser, so every check happens in one place and the request then goes out through Chromium's own network stack.

## Accepted limits

- **404 and 410 are recorded as reason `unreachable`.** A Queued Ingest has no not-found reason, and adding one would change the API and the frontend for a rare case. The plain fetch treats a 404 as final and queues nothing, so only a page that vanishes after queueing arrives here.
- **A transient failure goes straight to needs-page.** Nothing retries it, so an editor pastes the page.
- **An LLM save carries no photos.** The model sees only text, so there are no Candidate Photos to store.
- **The check is a substring match, and only for the title, ingredient lines and steps.** The description, author, yield and times aren't checked verbatim. A line that is a substring of a longer line on the page passes.
- **A page's size is checked only after rendering.** The browser loads the page whatever its size, then the CLI rejects one past the size limit as `unreachable`.

## Considered options

- **robots.txt on every subresource:** rejected. It makes many more requests to the site for a recipe, and a blocked script breaks the render that Playwright is there to do.
- **Pasted plain text, whether parsed by rules in the API, held on the Queued Ingest for the CLI's model, or typed into a form:** rejected for now. The household doesn't intend to use it yet. It may return for paper recipes.
- **A model called directly from the CLI:** rejected. The session that drives enrichment already answers Work Packets, so a second path to a model would need its own key, bill and rate limit for no gain.
