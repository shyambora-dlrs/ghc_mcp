# Local development

Prerequisites: **Node 22+** (Wrangler 4 / Vitest 5 require it; `.nvmrc`), Python 3.11+ (3.12 tested), Tesseract (`sudo apt install tesseract-ocr`) for OCR, Git. No Cloudflare or Groq account is needed for local work.

```bash
npm install                                   # workspaces: shared-types + mcp-worker
python3 -m venv .venv                         # if `ensurepip` is missing: python3 -m venv --without-pip .venv && python3 -m pip --python .venv/bin/python install -r ingestion/parser-service/requirements-dev.txt
.venv/bin/pip install -r ingestion/parser-service/requirements-dev.txt

cp .env.example apps/mcp-worker/.dev.vars     # edit; never commit (git-ignored)
npm run db:migrate:local                      # local D1 (miniflare) incl. FTS5
npm run db:seed:test                          # optional: synthetic seed data
npm run dev:mcp                               # Worker on :8787  (MCP at /mcp)
INGESTION_SERVICE_TOKEN=... PARSER_CALLBACK_TOKEN=... WORKER_ORIGIN=http://localhost:8787 npm run dev:parser   # parser on :8000
```

Tokens in `.dev.vars` must match between the Worker and parser: `INGESTION_SERVICE_TOKEN` (Worker→parser), `PARSER_CALLBACK_TOKEN` (parser→Worker), both ≥ 16 chars; `ADMIN_API_TOKEN` ≥ 16 chars for `/admin/*`.

## Live ingestion locally

`wrangler dev` (workerd) cannot validate the Court's incomplete TLS chain (see `docs/source-discovery.md`). Use push mode:

```bash
./scripts/build-ca-bundle.sh .local/ghconline-ca-bundle.pem          # verifies leaf → intermediate → system root
cd ingestion/parser-service
PARSER_CALLBACK_TOKEN=... CRAWLER_USER_AGENT="GHC-Cause-List-MCP/1.0 (contact: you@example.org)" \
  ../../.venv/bin/python -m app.cli crawl-push --worker http://localhost:8787 --ca-bundle ../../.local/ghconline-ca-bundle.pem --lookback-days 1
```
Then query: `npx @modelcontextprotocol/inspector --cli http://localhost:8787/mcp --transport http --header "Authorization: Bearer <MCP token>" --method tools/list`.
Parse a PDF you downloaded without any server: `cd ingestion/parser-service && ../../.venv/bin/python -m app.cli parse FILE.pdf --out out.json`.

## Checks

| Command | What |
|---|---|
| `npm run typecheck` | `tsc` for shared-types and the Worker |
| `npm run lint` | ESLint |
| `npm run test -w @ghc/mcp-worker` | 120+ Vitest tests: crawler, ingestion, versioning, FTS sync, search, injection safety, MCP via the real SDK client, Groq (mocked), routes |
| `npm run test:parser` | pytest: layouts A/B, OCR, validation, idempotency, service auth/SSRF, runner |
| `LIVE_HTML=page.html npx vitest run --root apps/mcp-worker live.page` | opt-in: parse a saved copy of the full live page |
| `node scripts/groq-smoke.mjs` | opt-in real Groq check (needs key) |
| `python tests/fixtures/synthetic/export_payloads.py` | regenerate the Python→Worker contract fixture (CI fails if stale) |

Tests use a D1-compatible shim over `node:sqlite` (the same SQLite engine and FTS5 that D1 uses). Real court PDFs are never committed; use `tests/fixtures/synthetic/`.
