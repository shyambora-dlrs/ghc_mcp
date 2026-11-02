-- 0001_init: core schema for the Gauhati High Court cause-list MCP.
-- All timestamps are UTC ISO-8601 strings. listing_date is YYYY-MM-DD only when confidently parsed.

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  source_page_url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  crawler_adapter TEXT NOT NULL DEFAULT 'ghc_wp_table_v1',
  last_attempted_at TEXT,
  last_successful_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One logical document as discovered on the official website. Identity = (source_id, canonical_url).
CREATE TABLE cause_list_documents (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  title TEXT,
  category_label_raw TEXT,
  category_normalized TEXT,
  listing_date TEXT,
  listing_date_raw TEXT,
  date_parse_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  source_url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  final_url TEXT,
  source_filename TEXT,
  court_or_establishment_label TEXT,
  publication_label TEXT,
  discovery_metadata_json TEXT,
  first_discovered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  current_version_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_id, canonical_url)
);
CREATE INDEX idx_docs_date_category ON cause_list_documents (listing_date, category_normalized);
CREATE INDEX idx_docs_source_status ON cause_list_documents (source_id, status);

-- Immutable once stored. A changed hash for the same logical document creates a new row.
CREATE TABLE document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES cause_list_documents(id),
  version_number INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  content_type TEXT,
  file_size_bytes INTEGER,
  page_count INTEGER,
  etag TEXT,
  last_modified_header TEXT,
  downloaded_at TEXT NOT NULL,
  parser_version TEXT,
  extraction_status TEXT NOT NULL,
  extraction_metadata_json TEXT,
  UNIQUE (document_id, version_number),
  UNIQUE (document_id, sha256)
);
CREATE INDEX idx_versions_document ON document_versions (document_id, version_number);

CREATE TABLE court_benches (
  id TEXT PRIMARY KEY,
  court_label_raw TEXT,
  court_number_normalized TEXT,
  bench_label_raw TEXT,
  judges_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE cause_list_entries (
  id TEXT PRIMARY KEY,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id),
  court_bench_id TEXT REFERENCES court_benches(id),
  serial_number TEXT,
  item_number TEXT,
  case_number_raw TEXT,
  case_number_normalized TEXT,
  case_number_key TEXT,
  case_type TEXT,
  case_year INTEGER,
  listing_date TEXT,
  listing_category_raw TEXT,
  listing_note_raw TEXT,
  section_heading_raw TEXT,
  connected_cases_json TEXT,
  page_start INTEGER,
  page_end INTEGER,
  raw_text TEXT NOT NULL,
  extraction_method TEXT NOT NULL,
  extraction_confidence REAL,
  validation_status TEXT NOT NULL,
  validation_flags_json TEXT,
  entry_index INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_entries_case_norm ON cause_list_entries (case_number_normalized);
CREATE INDEX idx_entries_case_key ON cause_list_entries (case_number_key);
CREATE INDEX idx_entries_date_bench ON cause_list_entries (listing_date, court_bench_id);
CREATE INDEX idx_entries_version_serial ON cause_list_entries (document_version_id, serial_number);
CREATE INDEX idx_entries_version_index ON cause_list_entries (document_version_id, entry_index);

CREATE TABLE case_parties (
  id TEXT PRIMARY KEY,
  cause_list_entry_id TEXT NOT NULL REFERENCES cause_list_entries(id),
  side TEXT NOT NULL CHECK (side IN ('PETITIONER','RESPONDENT','APPELLANT','RESPONDENT_SIDE','OTHER','UNKNOWN')),
  party_name_raw TEXT NOT NULL,
  party_name_normalized TEXT,
  sequence_number INTEGER
);
CREATE INDEX idx_parties_norm ON case_parties (party_name_normalized);
CREATE INDEX idx_parties_entry ON case_parties (cause_list_entry_id);

CREATE TABLE case_advocates (
  id TEXT PRIMARY KEY,
  cause_list_entry_id TEXT NOT NULL REFERENCES cause_list_entries(id),
  side TEXT NOT NULL CHECK (side IN ('PETITIONER','RESPONDENT','APPELLANT','OTHER','UNKNOWN')),
  advocate_name_raw TEXT NOT NULL,
  advocate_name_normalized TEXT,
  sequence_number INTEGER
);
CREATE INDEX idx_advocates_norm ON case_advocates (advocate_name_normalized);
CREATE INDEX idx_advocates_entry ON case_advocates (cause_list_entry_id);

CREATE TABLE document_pages (
  id TEXT PRIMARY KEY,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id),
  page_number INTEGER NOT NULL,
  text_content TEXT,
  extraction_method TEXT NOT NULL,
  ocr_confidence REAL,
  page_status TEXT NOT NULL,
  UNIQUE (document_version_id, page_number)
);

CREATE TABLE ingestion_jobs (
  id TEXT PRIMARY KEY,
  source_id TEXT,
  document_id TEXT,
  document_version_id TEXT,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_jobs_status_created ON ingestion_jobs (status, created_at);
CREATE INDEX idx_jobs_document ON ingestion_jobs (document_id, job_type);

CREATE TABLE ingestion_logs (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  level TEXT NOT NULL,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_logs_job ON ingestion_logs (job_id, created_at);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  event_type TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

-- Crawl statistics required by the operations spec (section 6.5).
CREATE TABLE crawl_runs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  elapsed_ms INTEGER,
  discovered_count INTEGER NOT NULL DEFAULT 0,
  new_count INTEGER NOT NULL DEFAULT 0,
  queued_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);
CREATE INDEX idx_crawl_runs_started ON crawl_runs (source_id, started_at);

-- Counters for Groq usage (operational metrics). One row per UTC day.
CREATE TABLE ai_usage_daily (
  day TEXT PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0
);
