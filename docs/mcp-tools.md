# MCP server

Endpoint: `POST https://<worker-host>/mcp` — **Streamable HTTP, stateless** (a fresh `McpServer` + `WebStandardStreamableHTTPServerTransport` per request, JSON responses).
SDK: `@modelcontextprotocol/sdk` 1.32.2. Verified with the SDK's own client (all 17 tools, structured output validated against the advertised `outputSchema`) and with the MCP Inspector CLI.
`GET /mcp` returns 405 (no server-initiated stream in stateless mode).

## Authentication & limits

* `Authorization: Bearer <token>` where the token is one of the comma-separated `MCP_AUTH_TOKENS` (Worker **secret**). In `APP_ENV=production` the endpoint returns **503** if none are configured; it never runs open in production.
* **OAuth is not implemented.** Static bearer tokens suit private deployments and Claude Code / Cursor / `mcp-remote`. For a multi-user or public deployment, put the Worker behind Cloudflare Access or add Cloudflare's OAuth provider library (MDS §11).
* Rate limits: `MCP_RATE_LIMIT_PER_MINUTE` (default 120) per client at the edge plus the same limit per tool call, and a separate `AI_RATE_LIMIT_PER_MINUTE` (default 10) for AI tools. The built-in limiter is per-isolate (best effort); bind Cloudflare's Rate Limiting API (`MCP_RATE_LIMITER`/`AI_RATE_LIMITER`, commented in `wrangler.jsonc`) for a global limit.
* CORS is not enabled (MCP clients are not browsers); authentication never relies on CORS.

## Connecting

```bash
# Claude Code
claude mcp add --transport http ghc-cause-list https://<worker-host>/mcp --header "Authorization: Bearer $GHC_MCP_TOKEN"
```
```jsonc
// Cursor: .cursor/mcp.json
{ "mcpServers": { "ghc-cause-list": { "url": "https://<worker-host>/mcp", "headers": { "Authorization": "Bearer <token>" } } } }
// Claude Desktop (claude_desktop_config.json), via the mcp-remote bridge
{ "mcpServers": { "ghc-cause-list": { "command": "npx", "args": ["-y", "mcp-remote", "https://<worker-host>/mcp", "--header", "Authorization: Bearer <token>"] } } }
```
Local: `http://localhost:8787/mcp`. MCP Inspector: `npx @modelcontextprotocol/inspector --cli http://localhost:8787/mcp --transport http --header "Authorization: Bearer <token>" --method tools/list`.

## Tools (all read-only; none accepts SQL or URLs)

All list-style tools return `{ success, query, results[], total, limit, next_cursor, warnings[], disclaimer }`. `limit` is 1–200; `cursor` is opaque. Dates are `YYYY-MM-DD`.
Every result entry carries `source { document_id, document_version_id, version_number, title, source_url, sha256, is_current_version }`, `page_start/page_end`, `extraction_method`, `extraction_confidence`, `validation_status`/`validation_flags`.

| Tool | Purpose | Notes |
|---|---|---|
| `get_available_dates` | Dates with a downloaded document, per category | Reports the **ingested dataset**, with a warning that absence ≠ unpublished. |
| `get_cause_lists` | Documents for a date/category with ingestion status | Includes not-yet-downloaded documents with honest status. |
| `search_case` | By case number | `match_type`: `EXACT` → `EXACT_VARIANT` (punctuation) → `PARTIAL` (only if no exact; labelled). Input is normalized (`wp(c) 1234 / 2026` ≡ `WP(C)/1234/2026`). Current versions only unless `include_previous_versions`. |
| `search_by_party`, `search_by_advocate` | By name (+ `side`) | FTS prefix tokens, all in one name; `PHRASE` ranks before `ALL_TOKENS`; source spelling preserved; no identity merging. |
| `search_by_court`, `get_court_schedule` | By court heading (`Court No. 3` or `3`) | Grouped by document + heading; warns on non-contiguous serials / uncertain entries. |
| `search_by_bench`, `get_bench_schedule` | By bench heading or judge text | Substring over text exactly as printed; no external knowledge of assignments. |
| `get_cases_by_date` | Paginated entries for a date (+category/court) | Several lists on one date stay distinguishable by `category_label_raw`/`source`. |
| `get_case_details` | One entry (by `entry_id`, or `case_number` + date/document) | Rejects ambiguous selectors, listing candidate ids. `include_raw_text`. |
| `get_document` | Metadata, versions, page-status counts, R2 availability | Optional short-lived HMAC-signed download path (`DOWNLOAD_SIGNING_SECRET`); no bucket credentials. |
| `get_document_page` | Extracted text of a 1-based page | Out-of-range pages explain the valid range. |
| `compare_cause_lists` | Added / removed / changed / ambiguous entries between two versions of one document | Never states disposal; ambiguity is exposed, not forced. |
| `get_ingestion_status` | Crawl times, job counts, status counts, freshness | Internal error text is admin-only. |
| `summarize_cause_list` 🤖 | AI summary of retrieved entries | Counts + citations are SQL-computed; falls back to exact counts when Groq is off/failing. |
| `explain_cause_list_terms` 🤖 | AI explanation of terminology | General vs source-specific are separated; errors are safe when AI is off. |

Resources (read-only, from the database): `ghc://sources`, `ghc://cause-lists/{date}`, `ghc://documents/{documentId}`, `ghc://documents/{documentId}/versions/{versionId}`, `ghc://documents/{documentId}/pages/{pageNumber}`.

**Regular Hearing list.** It covers a *date range* (e.g. 02.11.2026–23.12.2026) rather than one day, so its document and entries have `listing_date = null` (range in the document metadata) and therefore do **not** appear in date-filtered queries such as `get_cases_by_date`/`search_*` with `listing_date`. Find them with `category: "REGULAR_HEARING"` and no date.

Warnings you will see: data staleness (`STALE_AFTER_HOURS`, default 36 h), partial matches, uncertain extraction, non-contiguous serials, truncated pages.

## HTTP routes (non-MCP)

`GET /health`, `GET /health/ready` (public, no secrets); `/admin/*` (`ADMIN_API_TOKEN`): `GET /admin/ingestion/status`, `POST /admin/ingestion/crawl` (`{lookback_days?, wait?}`), `POST /admin/ingestion/documents/:id/retry`, `GET /admin/documents`, `GET /admin/jobs`, `GET /admin/jobs/:id`;
`/internal/*` (`PARSER_CALLBACK_TOKEN`, a **different** secret): PDF fetch, parse-result callbacks, `pending-parse`, push-mode `runner/*`; `GET /download/:versionId?exp&sig` (signed). There is no endpoint that accepts an arbitrary URL.
