# Gauhati High Court Cause List MCP

A remote [MCP](https://modelcontextprotocol.io) server that lets AI clients (Claude Code, Claude Desktop, Cursor, …) search the Gauhati High Court's **publicly published consolidated cause lists**
by case number, party, advocate, date, court and bench — with every answer traceable to the original PDF, version hash and page. Built on Cloudflare Workers (D1, R2, Queues, Cron) with a Python (PyMuPDF/Tesseract) parser and an *optional* Groq layer for summaries.

Source of truth: <https://ghconline.gov.in/index.php/consolidated-cause-list/> and the original PDFs. Extracted data is derivative; a listing is **not** proof that a matter was heard or disposed of; this is not legal advice.

```
apps/mcp-worker/        Worker: MCP (/mcp), crawler, queue consumer, admin & internal APIs, D1 repositories
ingestion/parser-service/  Python parser (CLI + FastAPI), push-mode runner, Dockerfile
packages/shared-types/  zod contracts + search-normalization shared by Worker and tests
database/               D1 migrations + synthetic seed
tests/                  source/PDF fixtures (synthetic), Python↔Worker contract fixture, MCP acceptance script
docs/                   architecture · source-discovery · database · parser · mcp-tools · groq · local-development · deployment · plan · accuracy
```

## Quick start

```bash
npm install && python3 -m venv .venv && .venv/bin/pip install -r ingestion/parser-service/requirements-dev.txt   # Node 22+, Python 3.11+
npm run typecheck && npm run lint && npm test         # 120+ worker tests, 30+ parser tests
cp .env.example apps/mcp-worker/.dev.vars && npm run db:migrate:local && npm run dev:mcp
```
Full local walkthrough (parser service, live push-mode ingestion, MCP Inspector): `docs/local-development.md`. Deploy: `docs/deployment.md`. Tools & client config: `docs/mcp-tools.md`.

## Verification status (read this)

| Verified | How |
|---|---|
| Crawler adapter on the **live** page | 2,034/2,034 links parsed; dates agree for 2,028, 4 filename-only, 1 conflict left NULL |
| **Live** download → R2 → queue → parser → D1 → MCP | Local `wrangler dev` (workerd, real D1/R2/Queues) + Python parser + push-mode runner, 2026-11-02: 8 PDFs stored, parsed lists searchable via real MCP clients |
| Parser completeness on **real** PDFs | printed serial numbers = parsed serials on 3 lists (814, 24, 1,606), 0 holes, 0 backwards; see `docs/parser-accuracy.md` for what this does *not* prove |
| Everything else | Automated tests (CI) incl. FTS sync, version history, injection safety, MCP schema validation, Groq error handling (mocked) |

| **Not** verified | Why / what to do |
|---|---|
| Production Cloudflare deploy; **whether production Workers can reach the Court site** | Needs your account. The Court's server sends an incomplete TLS chain (workerd fails closed locally). Push mode is the tested fallback → `docs/source-discovery.md#tls` |
| Real Groq calls / model choice | No API key available. `node scripts/groq-smoke.mjs`, then `docs/groq-configuration.md` |
| Docker image build | Docker unavailable in the build environment |
| Field-level extraction accuracy on real PDFs | No manually reviewed ground truth; ~7–22% of entries carry an advocate-wrap-heuristic flag |
| Terms of use of the Court's website | Not reviewed programmatically — please read them before production crawling |

## Safety

Read-only tools, no arbitrary SQL, no URL-accepting endpoints, three separate credentials (MCP / admin / parser), bearer auth required in production, parameterized SQL, immutable stored PDFs, staleness and uncertainty warnings, Groq key server-side only.
No real court PDFs or credentials are committed (`.gitignore`; fixtures are synthetic or index metadata only).
# ghc-mcp
# ghc-mcp
# ghc_mcp
# ghc_mcp
