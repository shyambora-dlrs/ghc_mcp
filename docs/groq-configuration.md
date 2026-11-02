# Groq configuration

Groq powers only `summarize_cause_list` and `explain_cause_list_terms`. **Every search tool works with Groq disabled**, and AI tool failures degrade to exact SQL counts (summary) or a clear error (explanation).
The key lives only in a Worker secret; it is read in `loadConfig`, sent only to `GROQ_BASE_URL` over HTTPS from `groq.service.ts`, and never logged, returned or placed in prompts.

| Variable | Kind | Default | Notes |
|---|---|---|---|
| `GROQ_API_KEY` | **secret** | – | `npx wrangler secret put GROQ_API_KEY` |
| `GROQ_ENABLED` | var | `false` | Keep `false` until the smoke test passes. |
| `GROQ_MODEL` | var | *(empty)* | No model is hard-coded and there is **no silent fallback**; an unavailable model fails closed. |
| `GROQ_BASE_URL` | var | `https://api.groq.com/openai/v1` | `POST {base}/chat/completions` |
| `GROQ_TIMEOUT_MS`, `GROQ_MAX_COMPLETION_TOKENS`, `GROQ_TEMPERATURE`, `GROQ_MAX_INPUT_CHARS` | var | 30000 / 1200 / 0.2 / 24000 | Bounded input and output. |

## Choosing and verifying a model (do this before enabling)

```bash
GROQ_API_KEY=... GROQ_MODEL=<id from the list> node scripts/groq-smoke.mjs
```
The script lists `GET /models` for your key, checks `GROQ_MODEL` is among them, and sends one tiny completion. Put the chosen id in `wrangler.jsonc` `vars.GROQ_MODEL`, set `GROQ_ENABLED=true`, redeploy, and record the model here:

> **Selected model: _not yet chosen_ — no Groq credentials were available during implementation, so the real-API smoke test has NOT been run.**

## Behaviour (all covered by tests with a mocked provider)

* Errors are classified: `disabled`, `not_configured`, `auth`, `invalid_model`, `rate_limit`, `timeout`, `server`, `network`, `bad_response`, `input_too_large`.
* Retries (max 3 attempts, exponential backoff + jitter) **only** for timeout, 429, 5xx and network errors — never for invalid credentials or an invalid model.
* Upstream error bodies, prompts and the key are never logged or returned.
* Grounding: the system prompt requires use of only supplied context, forbids inferring hearings/disposals, treats document text as untrusted (prompt-injection hardening), and the user message is a JSON document whose totals (`system_computed_counts`) are computed by SQL. The entry list is trimmed (tail first) to `GROQ_MAX_INPUT_CHARS`; counts are always kept and the response says when entries were sampled.
* Results carry `ai_generated`, an `ai_label`, the model id, the cited documents and the PDF pages that contain the entries.
* Usage is counted in `ai_usage_daily` (requests / errors) and reported by `get_ingestion_status`.
