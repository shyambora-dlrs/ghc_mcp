# Implementation plan & status (mapped to the MDS)

Legend: ✅ done and verified by an automated test · 🟢 done and verified manually/locally · 🟡 implemented, **not verified live** · ⛔ not implemented · ➖ needs the owner's credentials/account

## Phase 1 — Repository & source reconnaissance
- ✅ Inspected the live page (HTML, headers, links, categories, dates, PDFs) → `docs/source-discovery.md`
- ✅ Adapter `ghc_wp_table_v1` written from observed HTML; fixture of the real page; validated on all 2,034 live links (`live.page.test.ts`, opt-in)
- ✅ Dates parsed conservatively (link text ∩ filename; conflicts stay NULL)
- 🟢 Found: incomplete TLS chain on the Court's server → push-mode fallback (✅ tested) — **production Worker reachability is 🟡 unverified**

## Phase 2 — D1, R2, Queues, orchestration
- ✅ Migrations (tables, indexes, FTS5, cleanup trigger); parameterized repositories
- ✅ Crawl (discovery, lookback window, recheck window, caps), download (allowlist, redirects, size cap, `%PDF-`, sha256, conditional requests, immutable R2 keys), versioning (no duplicate on same hash; new version on change)
- ✅ Queue consumer (idempotent, poison-ack, quick retry on parser-busy, backoff, DLQ configured), job rows, logs, audit events, crawl stats
- 🟢 Verified on local workerd/D1/R2/Queues with a live push-mode run (2,034 discovered, 8 PDFs stored)

## Phase 3 — Parsing
- ✅ Python CLI + FastAPI service (auth, SSRF guard, single-job), PyMuPDF page extraction, per-page OCR fallback (Tesseract), layouts A/B, WITH/connected cases, validation & documented confidence
- ✅ Synthetic fixtures with ground truth; accuracy report (`docs/parser-accuracy.md`)
- 🟢 Real PDFs: serial completeness equals printed serials exactly on 3 lists (814/814, 24/24, 1,606/1,606), 0 holes. **Field-level accuracy on real PDFs is not measured** (no manually reviewed ground truth)
- ⛔ Optional LLM-assisted extraction (§7.4) — intentionally not implemented

## Phase 4 — Search & comparison
- ✅ Exact → variant → labelled partial case search; party/advocate (FTS + one-name token rule); court/bench/date; pagination; version comparison; stale-data warnings; injection tests

## Phase 5 — MCP server
- ✅ 17 tools + 5 resources, Streamable HTTP (stateless), zod input/output schemas validated by the real SDK client, bearer auth (503 if unset in production), rate limits
- 🟢 Verified with the SDK client and MCP Inspector CLI against the local Worker with real ingested data
- ⛔ OAuth (bearer tokens only); global rate limiter binding not enabled

## Phase 6 — Groq
- ✅ Server-side service, error classification, bounded retries, grounded prompts, SQL-computed counts, citations, graceful fallback, all with a mocked provider
- 🟡➖ **Real Groq call not made** (no key). Run `scripts/groq-smoke.mjs`, then set `GROQ_MODEL`/`GROQ_ENABLED`

## Phase 7 — Production readiness
- ✅ CI workflow, deploy workflow, `wrangler deploy --dry-run` bundle check, security review items (see `docs/architecture.md`)
- ➖ Create Cloudflare resources, real `database_id`, secrets, deploy Worker & parser, enable cron/push runner, GitHub secrets
- 🟡 Dockerfile written, **image not built** (Docker unavailable here)
- ⛔ Optional React admin dashboard (the admin API exists)

## Final acceptance (MDS §18)
| Item | Status |
|---|---|
| Source inspected; adapter based on observed HTML | ✅ |
| Categories stored as observed | ✅ |
| New and revised PDFs discovered; originals unchanged in R2; hash + versions persisted | ✅ (tests) / 🟢 (local R2) |
| Page-by-page extraction; OCR fallback | ✅ |
| Entries keep raw text + page refs | ✅ |
| Case/party/advocate/date/category/court/bench search; document & page retrieval | ✅ / 🟢 on real data |
| Version comparison; removal not read as disposal | ✅ |
| Streamable HTTP; schemas; pagination | ✅ |
| Authentication & rate limiting configured | ✅ (bearer, per-isolate limiter) · global limiter ➖ |
| Groq server-side, configurable, cited, optional | ✅ with mock · live verification 🟡➖ |
| Secrets not committed/returned | ✅ (`.gitignore`, redaction, tests) |
| Tests, lint, typecheck pass | ✅ |
| Deployment & client docs | ✅ |
| Live-source verification stated honestly | ✅ — see README "Verification status" |
