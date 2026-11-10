# The CLI turns a Queued Ingest into a recipe through a browser, recipe-scrapers and a model, and an editor pastes only HTML

Superseded in part by [2026-11-10-fallback-records-failed-attempts](2026-11-10-fallback-records-failed-attempts.md): a temporary failure now records its reason.

This settles what the [website ingest ADR](2026-10-24-website-ingest.md) left to [TaylorZowtuk/recipes#50](https://github.com/TaylorZowtuk/recipes/issues/50): how a Queued Ingest becomes a recipe, what the local fallback tries, and what an editor can paste. Everything else in that ADR stands.

The fallback runs in the local CLI, never in the API, as that ADR says. The API gains four endpoints, and a new module, `recipes.fallback`, runs the chain. The bulk import shares that module.

## A Queued Ingest becomes a recipe in one transaction

`POST /api/queued-ingests/{ingest_id}/recipe` takes a new recipe (its Source, Original, images and preview) and in one transaction deletes the Queued Ingest, repoints the Source Guard from the Queued Ingest to the recipe, and adds the recipe with its card. Of two saves of one Queued Ingest, only the first writes: the second gets a 404, or a 409 if they race. A body whose Source isn't the Queued Ingest's is a 422. The recipe is Pending enrichment, and its Ingest Channel stays *Add a recipe*: the fallback is another way of finishing an Add a recipe, not a new channel.

The other three endpoints:

- `POST /api/queued-ingests/{ingest_id}/needs-page {reason}` leaves a waiting Queued Ingest for an editor, every automated step having failed for `reason`. One that already needs its page stays as it is.
- `POST /api/queued-ingests/{ingest_id}/pasted-page {html}` captures a recipe from the HTML an editor pasted, scraped as the site the Source is on, and stores nothing. It returns what `POST /api/ingest` returns, with `extractor` set to `pasted-page`. The editor reviews it and saves it through the first endpoint. A page over the size limit is a 413, and one with no recipe is a 422. An editor can paste on a Queued Ingest in either state, waiting or needing its page.
- `DELETE /api/queued-ingests/{ingest_id}` discards a Queued Ingest in either state: one transaction deletes it and its Source Guard, so the Source can be ingested again. The guard's delete is conditional on the guard still pointing at that Queued Ingest, so a discard racing a save can never delete the recipe's guard. It answers 204. A Queued Ingest that has gone is a 404, and one that no longer holds the guard is a 409. A Queued Ingest isn't shared data, so `META#collection` stays as it is. Add a recipe asks the editor to confirm first.

An editor pastes the page's HTML only, never its text. The list in Add a recipe is now called "Waiting to be added".

## The chain

`python -m recipes.fallback run` takes each waiting website Queued Ingest through these steps, and stops at the first that gives a recipe:

1. **A browser.** Headless Chromium loads the page as Plateful, running its scripts.
2. **recipe-scrapers**, on the HTML the browser loaded. A recipe it reads is saved with `extractor` `playwright+recipe-scrapers`, with its Candidate Photos stored (a photo that fails to store is dropped).
3. **A model.** A page that loaded with no recipe recipe-scrapers can read goes into a Work Packet as its visible text. A model answers the packet, and `python -m recipes.fallback apply` checks each answer against the packet before saving it with `extractor` `llm`. An answer of null, or one that fails the check, marks the Queued Ingest as needing its page, reason `no_recipe`.
4. **Needs its page.** Whatever the chain can't read is marked `needs_page` with the reason it stopped, for an editor to paste. A page that loaded with no text at all is `no_recipe`.

A fetch that fails with reason `rate_limited`, `server_error` or `unreachable` writes nothing: the Queued Ingest stays `waiting`, and the next `run` tries it again. `run` counts these apart from its failures, and they don't make its exit code non-zero. A robots refusal, `blocked`, and a 404 or 410 still go to needs-page. `apply` only ever sees pages that loaded, so none of this reaches it.

A saved `pasted-page` Original comes from the editor's paste, not from the CLI.

The page's text goes into the packet and nowhere else: the CLI writes no file, and the packet goes to stdout. The model's answer is untrusted data, so it is checked against the page. The title, each ingredient line, each step and, when the answer gives them, the description, the author, the yield's text and each Stated Time's text must appear in the page's text word for word (whitespace aside, case kept) with no word character directly beside them. The Original must have ingredients and steps, and no two lines may share an id. The extractor is `llm` whatever the answer says. The check is on a model's answer only: a recipe-scrapers capture without steps is still saved, as the plain ingest saves one.

**An `llm` Original always stops at Awaiting Review.** A bulk import normally skips review and goes straight to Ready. It doesn't for an `llm` Original, because a model's reading is the one extraction no rule of the code produced, so an editor checks it.

## The browser's fetch policy

It is the plain fetch's policy, held at the browser's network layer.

- **robots.txt** is checked for the page, for each redirect hop and for each navigation the page makes. It isn't checked for subresources.
- **Images, media and fonts** are aborted, as a recipe isn't read from them.
- **Every request the guard sees must reach a public address.** A subresource that doesn't is dropped. A page or navigation that doesn't stops the fetch with reason `blocked`. The guard doesn't see every request: see Accepted limits.
- **Frames, popups, service workers, Workers and WebSockets are shut off.** A frame or popup runs out of sight of the guard that checks each request. Service workers are blocked in the context. The page's `Worker`, `SharedWorker`, `WebSocket`, `WebSocketStream`, `WebTransport`, `RTCPeerConnection` and `webkitRTCPeerConnection` are deleted before its scripts run, because they could open requests the guard never sees, and a worker could open any other from a scope the script doesn't run in.
- **The deadline** is 30 s for the whole fetch, with 5 s of it for the page's scripts to go quiet. A page that never does is read as it stands.

We use Chrome's Fetch domain, not Playwright routes, because a Playwright route fires only for the first request of a redirect chain. It can't check a hop. The Fetch domain pauses every request, each hop included, before it leaves the browser, so every check happens in one place and the request then goes out through Chromium's own network stack.

## Accepted limits

- **404 and 410 are recorded as reason `unreachable`.** A Queued Ingest has no not-found reason, and adding one would change the API and the frontend for a rare case. The plain fetch treats a 404 as final and queues nothing, so only a page that vanishes after queueing arrives here. It goes to needs-page, unlike any other `unreachable`.
- **A temporary failure stays waiting, however long it lasts.** There is no limit on retries, so a site that always fails stays waiting rather than being flagged, and every `run` tries it again. An editor can paste on it or discard it. `unreachable` also covers a redirect loop and a page past the size limit, which won't pass by themselves, and these wait too.
- **An LLM save carries no photos.** The model sees only text, so there are no Candidate Photos to store.
- **The check matches whole words, not whole lines.** A quote passes wherever it stands on the page, so a short real word such as "salt" passes as an ingredient, and two adjoining lines joined into one pass. Only the quotes are checked: a yield's `servings` and `unit`, a Stated Time's `seconds` and a line's `component` aren't.
- **A page's size is checked only after rendering.** The browser loads the page whatever its size, then the CLI rejects one past the size limit as `unreachable`, so it stays waiting.
- **robots.txt doesn't reach a page's own data requests.** A page's own script can read data by XHR or fetch from a path robots.txt refuses, and a recipe captured that way is saved. robots.txt stays on the page, redirects and navigations, because that is the simpler policy and more pages succeed.

- **A page can still reach a private address.** A speculation-rules prefetch is sent by the browser without passing the guard, and no Chromium flag tried stopped it. So a page an editor queued can make the CLI send a GET to an address on the developer's network. It can't read the reply. Routing the browser through a proxy that checks each address would close this: [TaylorZowtuk/recipes#133](https://github.com/TaylorZowtuk/recipes/issues/133).
- **DNS rebinding reaches further than in the plain fetch.** The guard resolves a host separately from Chromium, and a page's scripts run for up to 30 s, so a rebound host could let a page send a request to a private address and read the reply, not just make a blind GET. Chromium's Local Network Access checks are what stand in the way today. The same proxy would close this.
- **Chromium runs without its sandbox.** Playwright starts it that way, and the sandbox doesn't start in the toolchain container. A renderer exploit would run beside the service token and a writable checkout. It needs a Chromium bug as well as a hostile page.
- **The model that answers a Work Packet may have tools.** The packet holds untrusted page text, and the household answers it in the Claude Code session that drives enrichment, which has a shell and the service token. Page text could try to steer that session. Its only defences are the packet's instruction to treat the text as data and the session's own permission prompts. `apply` checks only the final answer.

## Considered options

- **robots.txt on every subresource, or only on data requests (XHR and fetch):** rejected. On every subresource it makes many more requests to the site for a recipe, and a blocked script breaks the render that Playwright is there to do. On data requests alone it is a second rule to hold beside the page's, and a page whose data is refused renders with no recipe, so fewer pages succeed.
- **Pasted plain text, whether parsed by rules in the API, held on the Queued Ingest for the CLI's model, or typed into a form:** rejected for now. The household doesn't intend to use it yet. It may return for paper recipes.
- **A proxy that checks and pins each address the browser connects to:** deferred to [TaylorZowtuk/recipes#133](https://github.com/TaylorZowtuk/recipes/issues/133). It closes the prefetch and DNS rebinding limits at one point, but it is new security-critical code, HTTPS tunnelling included.
- **Answering a Work Packet in a session with no tools and no token:** rejected for now. It adds a step to every run, and the household keeps one session for enrichment and the fallback.
- **A model called directly from the CLI:** rejected. The session that drives enrichment already answers Work Packets, so a second path to a model would need its own key, bill and rate limit for no gain.
