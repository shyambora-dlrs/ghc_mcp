# Deployment (Cloudflare)

> **Nothing has been deployed.** Deploying needs your Cloudflare credentials and an explicit action from you; this repo only prepares configuration. The Worker bundle was validated with `wrangler deploy --dry-run`.
> Local runtime verification (workerd + D1 + R2 + Queues + parser) is described in `docs/local-development.md`.

## 1. Create resources (once)

```bash
cd apps/mcp-worker
npx wrangler login                                            # or set CLOUDFLARE_API_TOKEN
npx wrangler d1 create ghc-cause-list-db                      # → copy the printed database_id into wrangler.jsonc (replace 00000000-…)
npx wrangler r2 bucket create ghc-cause-list-documents
npx wrangler queues create ghc-cause-list-ingestion
npx wrangler queues create ghc-cause-list-ingestion-dlq       # dead-letter queue (already referenced by the consumer config)
```
Never deploy the placeholder id (the deploy workflow refuses to).

## 2. Migrations

```bash
npx wrangler d1 migrations apply ghc-cause-list-db --remote   # confirm both 0001 and 0002 report ✅ before enabling ingestion
```

## 3. Configuration

Edit non-secret `vars` in `wrangler.jsonc`: `APP_ENV=production`, `APP_BASE_URL=https://<worker-host>` (used to build parser callback URLs), `CRAWLER_USER_AGENT` with a **real contact address**, `INGESTION_SERVICE_URL` (add as a var once the parser is deployed), crawl window vars.

Secrets (each is a distinct credential; use ≥ 32 random chars):
```bash
npx wrangler secret put MCP_AUTH_TOKENS           # comma-separated bearer tokens for MCP clients (required in production)
npx wrangler secret put ADMIN_API_TOKEN           # /admin/*
npx wrangler secret put PARSER_CALLBACK_TOKEN     # parser → Worker (/internal/*)
npx wrangler secret put INGESTION_SERVICE_TOKEN   # Worker → parser
npx wrangler secret put DOWNLOAD_SIGNING_SECRET   # optional: enables signed PDF links in get_document
npx wrangler secret put GROQ_API_KEY              # optional; see docs/groq-configuration.md (keep GROQ_ENABLED=false until verified)
```
Optional global rate limiting: create the Rate Limiting namespaces and uncomment `ratelimits` in `wrangler.jsonc`.

## 4. Parser service (Python)

`ingestion/parser-service/Dockerfile` (python:3.12-slim + Tesseract; **not built in this environment — Docker was unavailable, so build and smoke-test it first**).
Run it on any container host with: `INGESTION_SERVICE_TOKEN`, `PARSER_CALLBACK_TOKEN` (same values as the Worker secrets), `WORKER_ORIGIN=https://<worker-host>` (the SSRF allowlist for pdf/callback URLs), optional `PARSER_*` limits. It exposes `POST /jobs/parse` (bearer-protected) and `GET /health`; it processes **one job at a time** (returns 503 "busy" and the queue retries after 20 s). Give it ≥ 1 GB RAM for the 130-page lists.
It receives PDFs from the Worker's authenticated `/internal/versions/:id/pdf` route, so it needs **no R2 credentials**.

No always-on host? Skip the service and run `python -m app.cli run-pending --worker https://<worker-host>` on a schedule (versions stay `PENDING_PARSE` until then).

## 5. Deploy

```bash
npx wrangler deploy
```
The cron triggers (`30 2 * * *`, `30 10 * * *` UTC) only *discover* documents and enqueue downloads; downloading and parsing complete asynchronously. Trigger one now: `curl -X POST https://<worker-host>/admin/ingestion/crawl -H "Authorization: Bearer $ADMIN_API_TOKEN" -d '{"lookback_days":2,"wait":true}'`.

### ⚠️ First thing to verify: can the production Worker reach the Court's site?
Local `workerd` could not validate the Court's incomplete certificate chain (`docs/source-discovery.md`). If that crawl returns `UPSTREAM_ERROR`, switch to **push mode**: enable `.github/workflows/push-runner.yml` (secrets `WORKER_URL`, `PARSER_CALLBACK_TOKEN`, `CRAWLER_CONTACT`) or run `crawl-push` from any host, and remove the Worker cron (or leave it; failures are recorded and harmless).

## 6. CI/CD (GitHub)

`.github/workflows/ci.yml` (typecheck, lint, tests, pytest, `wrangler deploy --dry-run`, contract-fixture freshness) runs on PRs/main. `deploy.yml` deploys from `main` after CI succeeds, behind a `production` GitHub Environment (add required reviewers for a manual gate); it needs repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Groq/Worker secrets live in Cloudflare, never in the repo.

## 7. Post-deploy checklist

- [ ] `GET /health/ready` → `ready`
- [ ] MCP `tools/list` works with a bearer token; 401 without one
- [ ] Manual crawl succeeds (or push mode configured)
- [ ] A PDF is stored in R2, version row present, parser callback reaches `EXTRACTED`
- [ ] `search_case` finds a case you can see in the PDF at the cited page
- [ ] `GROQ_ENABLED` flipped on only after `scripts/groq-smoke.mjs` passes
- [ ] Logs/alerts: Workers Logs are enabled (`observability`); watch `crawl.failed`, `queue.message_failed`, `parser.failed`; dead-letter queue depth
