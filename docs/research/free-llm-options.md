# Free LLM options for ingest and runtime

Research for the ticket "Research: free LLM options for ingest and runtime" (map: "Wayfinder: household recipe app v1 spec").
All sources were read on **2026-09-24**. Free tiers change often, so re-check the linked pages before you rely on a number.

## Question

Which **free** LLM options can the app use during **enrichment** at ingest time and at runtime, with no recurring cost? How well does each fit these tasks:

- **(a)** mapping a free-text list of fridge ingredients onto **canonical ingredients** (runtime),
- **(b)** placing a new grocery item into one of the household's edited **store categories** (runtime),
- **(c)** parsing ingredients, suggesting substitutions and linking steps to ingredients during **enrichment** at ingest.

What happens when a free API is down or over quota?

## Short answer

- **(c) Enrichment at ingest:** use the **Gemini API free tier** (a Flash or Flash-Lite model with a JSON-schema response) as the primary option. Use **Groq's free plan** (`openai/gpt-oss-120b` with `strict: true` structured output) as the second provider. Enrichment runs once per recipe, and an editor starts it, so it can wait and retry. If both are unavailable, the recipe is saved with its **original** only and marked "enrichment pending", then retried later. Ingest never fails because an LLM is down.
- **(a) Fridge matching and (b) store-category placement at runtime:** these don't need a large model. Both are "pick from a closed list the household owns" problems. The primary path should be **deterministic**: a lookup of known wordings/aliases, then fuzzy matching. After that, an optional call to **Groq** (fast, strict JSON, generous daily quota) or **Gemini**, constrained to an enum of the existing canonical ingredients / store categories. The fallback when the call is down or over quota is the canonical-ingredient picker or category dropdown. The app never depends on the LLM for these tasks.
- **Cloudflare Workers AI** fits only if the backend runs on Cloudflare. It needs no key (it uses a binding), but 10,000 neurons/day is small for ingest, and its JSON mode is best-effort.
- **Not recommended:** GitHub Models (**retired 2026-07-30**). OpenRouter `:free` (50 requests/day without a $10 credit purchase, and the list of free models changes constantly). Mistral free mode (trains on inputs by default, and its limits are only visible after sign-up). In-browser models (WebLLM / Transformers.js) as a primary path: the download is too large and too unreliable on phones for a PWA. Transformers.js embeddings are a possible later option for offline fuzzy matching.
- **Data sensitivity:** the prompts contain recipe text and household ingredient lists. Nothing personal is involved, so the "may train on / humans may review" terms of the free Gemini tier are acceptable. The rule is: never send editor identities or secrets in prompts.

## Comparison

| Option | Free limits (as published) | Structured output | Latency | Data / terms | Free-tier stability | Key server-side? |
|---|---|---|---|---|---|---|
| **Gemini API free tier** | Per-model numbers only shown in AI Studio, not in the docs. Applied **per project, not per key**. RPD resets at midnight Pacific. "Not guaranteed" [G1] | Yes, JSON Schema response [G3] | Not measured. Flash/Flash-Lite are the fast models | Free-tier content **is used to improve products**. Human reviewers may read it. Not available in EEA/UK/CH. Must be 18+. "Do not submit sensitive… personal information" [G2][G4] | **Volatile.** Large cuts in Dec 2025 (forum reports of Flash dropping from 250 RPD) [G6]. Model list changes often [G4] | Yes. Plain HTTPS + key in an env secret. Canada/US are supported regions [G5] |
| **Groq free plan** | e.g. `openai/gpt-oss-120b` and `gpt-oss-20b`: **30 RPM, 1K RPD, 8K TPM, 200K TPD**. `qwen/qwen3.8-27b` is the same [Q1] | Yes. `strict: true` constrained decoding on GPT-OSS 20B/120B and Qwen 3.8 27B, "100% schema adherence" [Q2] | Very fast. Published speeds: GPT-OSS 120B ~500 tok/s, GPT-OSS 20B ~1,000 tok/s [Q3] | Does not retain inference data by default. May log for up to 30 days for abuse/reliability. Zero-data-retention toggle available [Q4][Q5] | Moderate. The free model lineup rotates, and preview models "may be discontinued at short notice" [Q3] | Yes. OpenAI-compatible HTTPS + key in an env secret |
| **Cloudflare Workers AI** | **10,000 neurons/day** free. Beyond that, calls fail unless on Workers Paid [C1]. 300 RPM default [C2] | JSON mode on a few models (Llama 3.x 8B/70B, etc.), but "can't guarantee" the schema. May return "JSON Mode couldn't be met". No streaming [C3] | Not measured | Cloudflare platform terms | Neuron prices are published per model [C1] | **No key needed** inside a Worker (the `env.AI` binding) [C4] |
| **OpenRouter `:free`** | **20 RPM, 50 RPD** (1,000 RPD after buying $10 of credit once) [O1] | Depends on the model. 20 free models today, ~7 advertise `structured_outputs` [O3] | Varies by upstream provider | Free and paid have separate training settings. Opting out of training reduces which providers are available [O2] | **Low.** The free list is mostly previews and "stealth" models that come and go [O3] | Yes (key in an env secret) |
| **Mistral free mode** | Only visible on the Admin "Limits" page after sign-up [M1] | Mistral supports JSON mode (not re-verified here) | Not measured | **Trains on inputs/outputs by default.** Opt-out available [M2] | Unknown | Yes |
| **GitHub Models** | — | — | — | — | **Retired 2026-07-30** for all customers [H1] | — |
| **In-browser: WebLLM** | No quota. Runs on the device | JSON mode / schema supported, OpenAI-compatible API [W1] | Needs a GB-scale model download before the first use. Slow on mid-range phones | Data stays on the device | Open source | N/A |
| **In-browser: Transformers.js** | No quota | No constrained JSON. Good at embeddings and zero-shot classification [W2] | Small models (tens of MB) run on WASM, and WebGPU is optional | Data stays on the device | Open source | N/A |

Browser support for WebGPU (needed by WebLLM): Safari iOS 26+, Chrome Android (caniuse lists full support from 152), Firefox Android disabled by default [W3].

## Detail by option

### Gemini API free tier (recommended primary for enrichment)

- The free tier covers most current Flash and Flash-Lite models (e.g. Gemini 3.8 Flash, 3.5 Flash-Lite, 2.5 Flash/Flash-Lite, Gemma 4) and embeddings. The pricing page marks "Used to improve our products: Yes" for every free model [G4].
- The rate-limit docs no longer publish per-model free numbers. They say to view them in AI Studio, limits are applied per project, RPD resets at midnight PT, and "specified rate limits are not guaranteed" [G1]. The real numbers must be read from the household's own AI Studio project once it has been created.
- Structured output: a JSON Schema can be passed as the response schema [G3]. This is the best fit for **enrichment** records (parsed ingredient lines, substitutions, step↔ingredient links).
- Terms (effective 2026-03-23): free-tier inputs/outputs may be used for product improvement and read by human reviewers. It is not for EEA/UK/CH users [G2]. The household is in Canada/US, and Canada is a supported region [G5]. Recipe text is not sensitive.
- Stability: Google cut free quotas sharply in December 2025, and developers reported large RPD reductions in the forum [G6]. Plan for it to shrink again.

### Groq free plan (recommended secondary for enrichment, primary LLM call at runtime)

- Published free-plan limits per model [Q1]:
  - `openai/gpt-oss-120b`: 30 RPM, 1,000 RPD, 8,000 TPM, 200,000 TPD
  - `openai/gpt-oss-20b`: 30 RPM, 1,000 RPD, 8,000 TPM, 200,000 TPD
  - `qwen/qwen3.8-27b`: 30 RPM, 1,000 RPD, 8,000 TPM, 200,000 TPD
- Going over a limit returns HTTP **429** with a `retry-after` header [Q1].
- Strict structured outputs (constrained decoding) on GPT-OSS 20B/120B and Qwen 3.8 27B [Q2]. An enum of the household's canonical ingredients or store categories can be put into the schema, so the model *cannot* invent a new one.
- The **8K TPM** limit is the constraint for enrichment. A long recipe prompt plus its output (~3–5K tokens) means roughly 1–2 recipes per minute. That is fine for an editor ingesting one recipe at a time.
- Speed: the fastest option (hundreds to ~1,000 tok/s) [Q3]. This matters for runtime (a) and (b), where a person is waiting.
- Data: not retained by default. Up to 30 days of logging for abuse/reliability. A ZDR opt-in is available [Q4][Q5].

### Cloudflare Workers AI (only if the backend is on Cloudflare)

- 10,000 free neurons/day. On the free plan, anything beyond that fails [C1].
- Worked estimate from the published neuron prices [C1]:
  - Llama 3.1 8B (fp8-fast) costs 4,119 neurons per million input tokens and 34,868 per million output tokens. A runtime call of ~500 tokens in and ~100 out costs ~6 neurons, so **~1,800 calls/day**.
  - Llama 3.3 70B (fp8-fast) costs 26,668 neurons per million input tokens and 204,805 per million output tokens. An enrichment call of ~3K tokens in and ~2K out costs ~490 neurons, so **~20 recipes/day**.
- JSON mode is best-effort and can return "JSON Mode couldn't be met" [C3]. You need validate-and-retry anyway.
- Its advantage is that there is no API key to manage, because it uses the `env.AI` binding [C4]. That only helps if the hosting decision picks Cloudflare Workers.

### OpenRouter free models (not recommended)

- 20 RPM and **50 requests/day** for accounts that have bought less than $10 of credits. The daily limit is 1,000 after a one-time $10 purchase [O1]. That purchase is a one-time cost, so the Notes on the map allow it.
- On 2026-09-24 the public models API listed **20** `:free` models out of 460. Only about 7 advertise `structured_outputs`, and many are previews or "stealth" models [O3]. We would have to pin a model that could disappear at any time.
- Could serve as an emergency third provider, since it is OpenAI-compatible, but it is not worth building around.

### Mistral free mode (not recommended)

- Free mode exists, but its limits are only shown on the Admin Limits page [M1]. Inputs/outputs are used for training unless you opt out [M2]. It offers nothing that Gemini or Groq don't already cover.

### GitHub Models (eliminated)

- Closed to new customers on 2026-06-16 and **fully retired on 2026-07-30**. The inference API is gone [H1].

### In-browser models (not a primary path)

- WebLLM needs WebGPU. It offers JSON-mode structured generation and an OpenAI-compatible API [W1]. However, a usable instruction model is a download of several hundred MB to GBs. That is a poor fit for an installable phone PWA that is also a cache-conscious offline app. It also needs Safari iOS 26+ or a recent Chrome Android [W3].
- Transformers.js runs small models on WASM (WebGPU is optional) and supports feature extraction (embeddings) and zero-shot classification [W2]. **Possible later use:** embed canonical ingredient names once and do nearest-neighbour matching on the device for (a) offline. This is an idea, not a v1 need.

## Fit for each task

| Task | Needs | Best fit | Why |
|---|---|---|---|
| (a) fridge text → canonical ingredients | Low latency, closed vocabulary, works on a phone | Deterministic alias/fuzzy match first, then **Groq** strict schema with an enum of canonical ingredients. **Gemini** as the second provider | Most wordings are already known from enrichment. The LLM only handles leftovers. An enum prevents invented ingredients |
| (b) new grocery item → store category | Low latency, tiny closed list (the household's categories) | Lookup via the item's canonical ingredient first, then **Groq** / **Gemini** with an enum of current store categories | One short call. Store the answer so it is never asked again |
| (c) enrichment at ingest | Long input, rich JSON schema, quality over speed, runs once | **Gemini** Flash (primary), **Groq** GPT-OSS 120B (secondary) | Gemini's JSON-schema output and larger quota fit long recipes. Groq's 8K TPM still handles one recipe at a time |

Guard rails that apply to all tasks: validate every response against the schema, and reject any canonical ingredient or store category that isn't in the enum. This matches the map's note that enrichment must not invent numbers.

## When a free API is down or over quota

- Gemini, Groq and OpenRouter all return **HTTP 429** when over quota. Groq and OpenRouter include retry/reset headers [Q1][O1]. Cloudflare's free plan simply fails past 10K neurons [C1].
- **Enrichment:** save the **original** immediately, mark enrichment as pending, and retry with backoff on the next provider (Gemini → Groq → optionally OpenRouter). An editor can trigger a retry. Because enrichment is stored once, a short outage only delays facts and never loses anything.
- **Runtime (a)/(b):** fall back to the deterministic match, then to the manual picker (canonical-ingredient picker / category dropdown). Never block the grocery list or fridge matching on an LLM call.
- Keep the provider behind one small server-side interface ("classify into enum", "enrich recipe → schema"). Then swapping providers when a free tier changes is a config change.

## Keys stay server-side

Gemini, Groq, OpenRouter and Mistral are all plain HTTPS APIs with a bearer key. The key belongs in the backend host's secret/env store, and all LLM calls go through the Python backend. The browser never sees the key. The repo is public, so keys must never be committed. Workers AI inside a Cloudflare Worker needs no key at all [C4]. Whether a particular host's free plan allows outbound HTTPS and secrets is part of the hosting decision.

## Open items

- Read the real Gemini free-tier RPM/RPD for the chosen model from the household's AI Studio project after it is created. The docs no longer publish these numbers.
- No latency was measured (no keys available during this research). A short prototype against Gemini Flash-Lite and Groq GPT-OSS 20B would confirm runtime latency for (a)/(b).

## Sources

- [G1] Gemini API rate limits: https://ai.google.dev/gemini-api/docs/rate-limits (last updated 2026-09-02; read 2026-09-24)
- [G2] Gemini API Additional Terms of Service: https://ai.google.dev/gemini-api/terms (effective 2026-03-23; read 2026-09-24)
- [G3] Gemini structured output: https://ai.google.dev/gemini-api/docs/structured-output (last updated 2026-09-23; read 2026-09-24)
- [G4] Gemini Developer API pricing: https://ai.google.dev/gemini-api/docs/pricing (last updated 2026-09-24; read 2026-09-24)
- [G5] Gemini available regions: https://ai.google.dev/gemini-api/docs/available-regions (last updated 2026-04-28; read 2026-09-24)
- [G6] Google AI Developers Forum, free-tier quota reduction threads (community, lower trust): https://discuss.ai.google.dev/t/clarification-on-gemini-api-free-tier-quota-reduction-and-paid-tier-stability/112941 and https://discuss.ai.google.dev/t/do-they-really-think-we-wouldnt-notice-a-92-free-tier-quota/111262 (read 2026-09-24)
- [Q1] Groq rate limits: https://console.groq.com/docs/rate-limits (read 2026-09-24)
- [Q2] Groq structured outputs: https://console.groq.com/docs/structured-outputs (read 2026-09-24)
- [Q3] Groq supported models: https://console.groq.com/docs/models (read 2026-09-24)
- [Q4] Groq "Your Data in GroqCloud": https://console.groq.com/docs/your-data (read 2026-09-24)
- [Q5] Groq Services Agreement: https://console.groq.com/docs/legal/services-agreement (read 2026-09-24)
- [C1] Workers AI pricing: https://developers.cloudflare.com/workers-ai/platform/pricing/ (read 2026-09-24)
- [C2] Workers AI limits: https://developers.cloudflare.com/workers-ai/platform/limits/ (read 2026-09-24)
- [C3] Workers AI JSON mode: https://developers.cloudflare.com/workers-ai/features/json-mode/ (read 2026-09-24)
- [C4] Workers AI bindings: https://developers.cloudflare.com/workers-ai/configuration/bindings/ (read 2026-09-24)
- [O1] OpenRouter limits: https://openrouter.ai/docs/api/reference/limits (read 2026-09-24)
- [O2] OpenRouter provider logging / data policy: https://openrouter.ai/docs/guides/privacy/provider-logging (read 2026-09-24)
- [O3] OpenRouter models API: https://openrouter.ai/api/v1/models (queried 2026-09-24: 460 models, 20 `:free`)
- [M1] Mistral usage and limits: https://docs.mistral.ai/admin/user-management-finops/tier (read 2026-09-24)
- [M2] Mistral Help Center, training on user data: https://help.mistral.ai/en/articles/347617-do-you-use-my-user-data-to-train-your-artificial-intelligence-models (read 2026-09-24)
- [H1] GitHub Changelog, "GitHub Models is now retired": https://github.blog/changelog/2026-07-30-github-models-is-now-retired/ (2026-07-30; read 2026-09-24)
- [W1] WebLLM README: https://github.com/mlc-ai/web-llm (read 2026-09-24)
- [W2] Transformers.js docs: https://huggingface.co/docs/transformers.js/index (read 2026-09-24)
- [W3] Can I use: WebGPU: https://caniuse.com/webgpu (read 2026-09-24)
