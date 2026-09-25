# Research: free hosting for a Python backend, a TypeScript PWA and image storage

Question (from the ticket "Research: free hosting for a Python backend, a TypeScript PWA and image storage"): which hosting options let the app run for **$0 recurring**? The app has a Python backend (API, editor sign-in, saving edits), a TypeScript PWA and storage for 100–500 recipe images (growing).

All limits below were read from the provider's own pricing/docs page on **2026-09-24**. Free tiers change often, so re-check the linked page before relying on a number.

## Short answer

| # | Combination | Why it works | Main trade-offs |
|---|---|---|---|
| **A (recommended)** | **All Cloudflare:** PWA as Workers static assets (or Pages) + **Python Worker** (FastAPI) + **D1** + **R2** for images | No sleeping, cold starts cut by memory snapshots, static asset requests free and unlimited, Workers/D1 hard-stop instead of billing, R2 egress is free and 10 GB is far more than 500 images | Python runs on Pyodide (WebAssembly), so only pure-Python or Pyodide-built packages work. Free plan gives **10 ms CPU per request**, which is tight for Python. R2 needs a payment method on file and **bills** past the free tier (it does not hard-stop). |
| **B** | PWA on Cloudflare (static assets/Pages) + images on R2 + **Python on Vercel Hobby** (FastAPI/Flask as Vercel Functions) + a hosted SQLite/DB (Turso or D1 over HTTP) **or** git as the source of truth | Real CPython with any package, first-class FastAPI/Flask/Django support; Hobby hard-stops rather than bills | Serverless cold starts; no persistent disk, so the data has to live in a DB or in git; Hobby is **non-commercial only** (fine for one household); going over the limit means a 30-day wait. Two vendors. |
| **C** | **Oracle Cloud Always Free** Ampere VM (2 OCPU / 12 GB) running FastAPI + SQLite on block volume, images on disk or OCI Object Storage (20 GB); PWA on Cloudflare or GitHub Pages | A real always-on server: any Python stack, no cold starts, 200 GB block storage, 10 TB egress | You run the server yourself (OS patches, TLS, backups). Credit card needed at signup. Oracle reclaims VMs that are **idle** (<20% CPU, network and memory over 7 days), and a household app will be idle. |
| **D (fallback only)** | PWA on Cloudflare/GitHub Pages + images on R2 + **Render free web service** with **git as the source of truth** (backend commits through the GitHub API) | Plain CPython container, any framework | Sleeps after 15 min with no traffic and takes about 1 min to wake. Filesystem is wiped on each restart. Free Postgres **expires after 30 days**, so there is no durable datastore and git has to be the only one. |

**Recommendation:** go with **A**. It is the only option that puts all three parts on one account with no sleeping and hard stops on compute and DB. Before locking it in, have the prototype confirm that FastAPI plus our ingest/parsing dependencies load on Pyodide and stay within the 10 ms CPU budget for typical requests. If they don't, keep Cloudflare for the PWA and R2 and move only the Python API to **B** (Vercel).

**Ruled out:** Fly.io (no free tier any more, only a 7-day / 2-machine-hour trial), Firebase (Cloud Storage and Functions now need the Blaze pay-as-you-go plan), Netlify and Deno Deploy (no Python runtime), and Supabase as the *main* host (free projects pause after 1 week of inactivity, which is likely for a household app; it can still serve as a DB/storage add-on if it is pinged).

**Public-repo note:** scraped recipe text and images are other people's copyrighted work. If "files in git are the source of truth", keep that data out of this public repo, either in a separate **private** GitHub repo or in R2/D1. Images should not go in git in any case.

---

## Per-provider findings

### Cloudflare (Workers, Python Workers, Pages, D1, R2)

- **Workers Free plan**: 100,000 requests/day (resets at midnight UTC), **10 ms CPU per request**, 128 MB memory, 64 MiB bundle, 50 subrequests per request. Going over causes errors (1027 for the daily limit, 1102 for resource limits), **not billing**. Waiting on network/KV/DB I/O does not count as CPU time. Global scope must start within 1 s. Source: https://developers.cloudflare.com/workers/platform/limits/ (read 2026-09-24)
- The Free plan has no bill. Paid starts at $5/month minimum and only if you upgrade. Workers KV free: 100k reads/day, 1k writes/day, 1 GB. Source: https://developers.cloudflare.com/workers/platform/pricing/ (2026-09-24)
- **Static assets on Workers**: "Requests to static assets are free and unlimited." Up to 20,000 files per version and 25 MiB per file on Free. Sources: https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/ and the limits page above (2026-09-24)
- **Pages Free**: 500 builds/month, 1 build at a time, 20,000 files, 25 MiB per file, 100 custom domains per project. Source: https://developers.cloudflare.com/pages/platform/limits/ (2026-09-24)
- **Python Workers**: the docs list FastAPI, Pydantic and Langchain as supported. They need the `python_workers` compatibility flag. Packages must be pure Python, PyEmscripten wheels, or bundled with Pyodide ("WebAssembly support for Python packages is still in early stages"). Cold starts are reduced by snapshotting WebAssembly memory at deploy time. Sources: https://developers.cloudflare.com/workers/languages/python/, https://developers.cloudflare.com/workers/languages/python/packages/, https://developers.cloudflare.com/workers/languages/python/how-python-workers-work/ (2026-09-24). Active development: Python 3.14 (Pyodide 314.0.6) shipped for compatibility date 2026-09-08 (https://developers.cloudflare.com/changelog/post/2026-09-08-python-workers-314/), and Hyperdrive support landed 2026-09-16 (https://developers.cloudflare.com/changelog/post/2026-09-16-hyperdrive-python-workers/).
- **D1 Free**: 5 M rows read/day, 100k rows written/day, 5 GB total storage. Over the daily limits, queries return errors. Over the storage limit, writes are blocked until data is deleted. No billing. Source: https://developers.cloudflare.com/d1/platform/pricing/ (2026-09-24)
- **R2 free tier**: 10 GB-month storage, 1 M Class A ops/month, 10 M Class B ops/month, **free egress** (Standard storage only). Beyond that: $0.015/GB-month, $4.50/M Class A, $0.36/M Class B. Source: https://developers.cloudflare.com/r2/pricing/ (2026-09-24). You must "complete the checkout flow to add an R2 subscription" before use (https://developers.cloudflare.com/r2/get-started/, 2026-09-24), so a payment method is on file and usage past the free tier **is billed**, not stopped. Sizing: 500 images at about 300 KB each is about 150 MB, roughly 1.5% of the free storage.
- **GitHub integration**: Workers and Pages deploy from GitHub (Workers Builds / Pages Git integration) or from GitHub Actions with `wrangler`. A Worker can commit to a repo through the GitHub REST API (see "GitHub" below).
- **Terms/tier-change risk**: medium-low. The Workers free plan has been stable for years, and D1 and R2 free allowances are documented as hard numbers. The main risk is R2 being metered rather than capped.

### Vercel (Hobby)

- **Included per month**: 1 M function invocations, 4 active-CPU hours, 360 GB-hrs provisioned memory, 100 GB Fast Data Transfer, 1 M edge requests, 5,000 image transformations. Max function duration 300 s. 100 deployments/day. Going over means "you will have to wait until 30 days have passed before you can use the feature again" (**hard stop, no billing**). **Hobby is non-commercial, personal use only.** Source: https://vercel.com/docs/plans/hobby (page updated 2026-09-14, read 2026-09-24)
- **Python**: ASGI/WSGI apps with presets for FastAPI, Flask and Django. Python 3.12 (default), 3.13 and 3.14. 500 MB bundle limit. "Services" can run a Python backend and a frontend in one project. Source: https://vercel.com/docs/functions/runtimes/python (2026-09-24)
- **Blob (Hobby)**: 1 GB storage, 10k simple ops, 2k advanced ops, 10 GB data transfer per month. Over the limit, Blob is **inaccessible for 30 days, no charge**. Dashboard browsing counts as advanced operations. Source: https://vercel.com/docs/vercel-blob/usage-and-pricing (2026-09-24). For our image count, 2k uploads/month is enough, but a lost month of image access is a harsh failure mode.
- **Persistence**: no local disk, so data has to go to Blob, a marketplace DB, or git.
- **Risk**: medium. Vercel has repriced several times (see its "improved infrastructure pricing" posts), and the non-commercial clause is binding.

### Netlify (Free)

- 300 credits/month "with a hard limit and no auto recharge option", and "You'll never be charged for the Free plan." Credits are spent on production deploys (15 each), bandwidth (20/GB), requests (2 per 10k) and compute (10 per GB-hour). Sources: https://www.netlify.com/pricing/ and https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/ (2026-09-24). At 15 credits per production deploy, **20 deploys use the whole month's credits**. That is a poor fit if content commits trigger deploys.
- Functions docs show only TypeScript/JavaScript. **No Python runtime.** Source: https://docs.netlify.com/build/functions/overview/ (2026-09-24)

### GitHub Pages / GitHub Actions / GitHub API

- **Pages**: site of 1 GB or less, soft limit of 100 GB/month bandwidth, soft limit of 10 builds/hour (not applied to custom Actions workflows), HTTP 429 when over quota. Not for commercial/SaaS use or handling passwords. Static hosting only. Source: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits (2026-09-24)
- **Actions**: "free … for public repositories that use standard GitHub-hosted runners." Source: https://docs.github.com/en/billing/concepts/product-billing/github-actions (2026-09-24)
- **Committing from a backend**: `PUT /repos/{owner}/{repo}/contents/{path}` with a base64 body. Requests must be **serial** (parallel create/delete calls conflict), and files over 1 MB have restrictions. Source: https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents (2026-09-24). Any HTTP-capable host (Workers, Vercel, Render) can use this. Editor saves would need to be serialized (a queue or retry on SHA conflict).

### Render (Free)

- Free web services spin down after **15 minutes** without inbound traffic and take about **1 minute** to spin up. There are 750 free instance hours per workspace per month; once they are used up, all free services are suspended until next month. The filesystem is ephemeral ("lost every time the service redeploys, restarts, or spins down"), and there are **no persistent disks** on free. Free Postgres **expires 30 days after creation**, with a 14-day grace period before deletion. Going over bandwidth without a card suspends services. Python supported. Source: https://render.com/docs/free (2026-09-24). The exact bandwidth allowance was not stated on the pages read.
- Deploys from GitHub. Deploy hooks can be called from Actions.

### Fly.io

- "All organizations … require a credit card on file." Source: https://docs.fly.io/about/pricing/ (2026-09-24)
- New orgs get only a trial of "2 hours of machine runtime or 7 days of access, whichever comes first", and trial machines auto-stop after 5 minutes. After the trial, apps stop until billing is set up. There is **no ongoing free allowance**. Source: https://docs.fly.io/about/free-trial/ (2026-09-24). **Not viable.**

### Supabase (Free)

- 500 MB database, 1 GB file storage, 5 GB egress + 5 GB cached egress, 50k MAU, 500k edge function invocations, 2 active projects. Projects are **"paused after 1 week of inactivity"**. Source: https://supabase.com/pricing (2026-09-24)
- No Python hosting (edge functions are Deno/TypeScript). Useful only as a Postgres + auth + storage add-on, and the pausing rule is a real risk for a low-traffic household app.

### Turso (Free)

- 100 databases, 5 GB storage, 500 M rows read and 10 M rows written per month, 3 GB syncs. "Extra … beyond your plan are billed automatically **once enabled**", so overage is opt-in. No inactivity rule is stated on the page. Source: https://turso.tech/pricing (2026-09-24)
- A good DB for combination B (SQLite over HTTP from Vercel functions). Not a compute host.

### Firebase (Spark)

- Hosting: 10 GB storage, 360 MB/day transfer. Firestore: 1 GiB, 50k reads/day, 20k writes/day. Source: https://firebase.google.com/pricing (2026-09-24)
- **Cloud Storage for Firebase now requires Blaze** (effective **2026-02-03**). Spark projects lose read/write access, and API calls return 402/403. Source: https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024 (2026-09-24). Blaze is pay-as-you-go with a card and no hard cap, so it does not meet the $0 guarantee. **Not viable for images.**

### Deno Deploy (Free)

- 1 M requests/month, 20 GiB egress, 10 h active CPU, 1 GiB KV. The pricing page does not say what happens past these limits. Source: https://deno.com/deploy/pricing (2026-09-24). Limits doc: 512 MB memory, 1 GB deployment, "No uptime guarantees … during the initial public beta". Source: https://docs.deno.com/deploy/pricing_and_limits/ (2026-09-24)
- JavaScript/TypeScript only, **no Python**. It could host the PWA, but Cloudflare already covers that better.

### Oracle Cloud (Always Free)

- Ampere A1: 1,500 OCPU-hours and 9,000 GB-hours per month (2 OCPU / 12 GB). Up to 2 AMD micro VMs (1/8 OCPU, 1 GB). 200 GB block volume. Object Storage 20 GB and 50k API requests/month (Always Free-only accounts). 10 TB/month egress. **Idle reclamation**: an instance counts as idle if over 7 days its 95th-percentile CPU, network and (for A1) memory are all below 20%. Source: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm (2026-09-24)
- Signup needs a phone number and a credit card, but "Your credit card will not be charged unless you upgrade your account". Always Free resources keep running after the 30-day trial. Source: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm (2026-09-24)
- Any Python framework. GitHub Actions can deploy over SSH.
- **Risk**: idle reclamation of a low-traffic VM (a synthetic load cron can work around it but is fragile), plus all the operations work of running a VM.

## Open points for the stack/hosting decision

- Prototype: does FastAPI + our recipe parsing (e.g. `recipe-scrapers`, `lxml`) import on Pyodide, and how much CPU does a typical request use against the 10 ms budget? Scraping could run in GitHub Actions (real CPython, free on a public repo) instead of in the Worker.
- Decide whether the R2 "card on file, metered" model is acceptable for $0 recurring, or whether to set a usage alert. The alternative is Vercel Blob's hard stop (1 GB) at the cost of up to 30 days without images.
