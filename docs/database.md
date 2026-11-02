# Database (Cloudflare D1 / SQLite)

Migrations: `database/migrations/0001_init.sql` (tables, indexes), `0002_fts.sql` (FTS5 + cleanup trigger). `wrangler.jsonc` points `migrations_dir` at that folder.
Verified on the real local D1 engine (`wrangler d1 migrations apply … --local`) and in tests (real SQLite with FTS5). All timestamps are UTC ISO-8601; `listing_date` is `YYYY-MM-DD` only when confidently parsed.

| Table | Purpose / notable columns |
|---|---|
| `sources` | One row per source; `last_attempted_at`, `last_successful_at`, `crawler_adapter`. |
| `cause_list_documents` | Logical document; identity `UNIQUE(source_id, canonical_url)`; raw + normalized category, `listing_date_raw`, `date_parse_status` (`CONFIRMED`/`LINK_TEXT`/`FILENAME_ONLY`/`CONFLICT`/`RANGE`/`UNPARSED`), `publication_label`, `current_version_id`, `status`. |
| `document_versions` | **Immutable** PDF versions: `sha256`, `r2_key`, `etag`, `last_modified_header`, `page_count`, `parser_version`, `extraction_status`, `extraction_metadata_json`. `UNIQUE(document_id, version_number)` and `UNIQUE(document_id, sha256)`. |
| `court_benches` | Deduplicated court/bench headings; `judges_json` = `{judges[], notes[], sitting_time_raw}`; `court_number_normalized`. |
| `cause_list_entries` | One entry per version: raw + normalized case number, `case_number_key` (punctuation-insensitive lookup), `section_heading_raw`, `listing_note_raw`, `connected_cases_json`, page range, `raw_text`, method, confidence, `validation_status`/`validation_flags_json`, `entry_index`. |
| `case_parties`, `case_advocates` | Raw + normalized names with side and sequence (normalized values are for search only). |
| `document_pages` | Page text per version (1-based), method, OCR confidence, `page_status`. |
| `ingestion_jobs`, `ingestion_logs`, `audit_events`, `crawl_runs`, `ai_usage_daily` | Operations. |
| `cause_list_fts` | FTS5: `case_number, parties, advocates, note, court, raw_text` (`unicode61 remove_diacritics 2`). |

**FTS maintenance.** Parties/advocates are inserted after their entry, so insertion-time indexing is explicit and part of the same D1 batch as the entry (`ingestion.service.ts`).
Removal is by trigger `trg_entries_delete_cleanup` (deleting an entry removes its FTS row, parties and advocates). Tests assert the index stays in sync on ingest, re-delivery, and re-parse.

**Immutability.** A changed PDF hash creates a new `document_versions` row and a new R2 object (keys embed version and hash and are never overwritten); entries are tied to a version. Re-parsing the *same* version
replaces only that version's derived rows (`begin` phase) and is audited; it never touches other versions.

**Ranking.** Exact normalized (`case_number_normalized`) → punctuation-insensitive key → labelled partial matches (only when no exact match exists). Party/advocate: full phrase before all-token matches; tokens must co-occur in **one** person's name.

D1 notes: ≤ 100 bound parameters per statement (IN-lists chunked at 80); batches are chunked; SQLite `?NNN` placeholders are avoided for portability. A future PostgreSQL move would go through the service/repository layer; tool contracts would not change.
