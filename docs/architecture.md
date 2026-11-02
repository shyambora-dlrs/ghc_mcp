# Architecture

```
Court website ──(HTML table + PDFs; incomplete TLS chain)───────────────────────────────┐
                                                                                        │
 Cron (twice daily) ─► Worker: crawl (discovery only) ─► D1 documents ─► Queue ─► Worker consumer (1 msg at a time)
                          ▲  or push mode: runner ─► /internal/runner/*          │ DOWNLOAD_AND_STORE: conditional GET, %PDF- check,
                          │  (CA bundle with the missing intermediate)           │ size cap, sha256, R2 put (immutable key), version row
                          │                                                      ▼
                          │                                          PARSE_DOCUMENT_VERSION ─► Python parser service ──┐
                          │                                                                   (PyMuPDF, OCR per page)   │
 MCP clients ─► Worker /mcp (Streamable HTTP, bearer auth, rate limits) ◄── D1 (entries, FTS5) ◄── /internal/versions/:id/parse-result
              │            └─► R2 (original PDFs; signed short-lived links)        (begin → chunks → complete; validated by zod)
              └─► optional Groq (server-side only; summaries/explanations over SQL-retrieved context)
```

Key decisions (MDS §21): D1 is the searchable store (exact + FTS5, no vectors); R2 keeps the original PDFs, immutable and content-addressed; the parser is a separate Python process that never holds storage credentials; queues decouple crawl/download/parse so MCP requests never parse PDFs;
Groq adds language, not facts — totals and citations come from SQL.

* **Idempotency.** Document ids are deterministic (`sha256(source, canonical URL)`); versions are unique per `(document, sha256)`; entry ids are deterministic per `(version, index)`; every parse phase can be re-delivered; queue handlers ack poison messages and retry others (`max_retries 5`, dead-letter queue).
* **Failure honesty.** A source layout change raises (no documents ≠ "no lists today"); an extraction that finds nothing is `REVIEW_REQUIRED`, never `EXTRACTED`; stale data produces warnings.
* **Security.** Three distinct credentials (MCP clients / admin / parser). Crawler URLs: https + allowlisted host only, redirects re-validated, no endpoint accepts a URL. PDFs and HTML are treated as data; the parser validates signature/size/page counts and only fetches from the configured Worker origin. Parameterized SQL only (user text never reaches SQL text; FTS expressions are built from `[A-Z0-9]` tokens; LIKE patterns are escaped). Public errors are generic, details stay in structured logs (secret-looking keys are redacted).
* **Observability.** Structured JSON events (`crawl.*`, `document.*`, `parser.*`, `mcp.tool_*`, `groq.*`), `ingestion_jobs`/`ingestion_logs`/`crawl_runs`/`audit_events` tables, `get_ingestion_status` and `/admin/ingestion/status` metrics.

## Not implemented (deliberately or pending)

OAuth for MCP clients (bearer tokens only); the optional React admin dashboard (§16) — the admin **API** exists; the optional LLM-assisted parser fallback (§7.4); a global rate limiter (binding documented, not enabled); Vectorize/embeddings (out of scope by design).
