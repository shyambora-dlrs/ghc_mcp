-- SYNTHETIC TEST DATA ONLY. Invented names and an example.invalid URL; nothing here comes from the Court.
-- Load locally with: npm run db:seed:test
INSERT OR IGNORE INTO sources (id, source_key, name, source_page_url, enabled, crawler_adapter, last_attempted_at, last_successful_at, created_at, updated_at)
VALUES ('src_seed', 'ghc_consolidated_cause_list', 'Gauhati High Court Consolidated Cause List', 'https://ghconline.gov.in/index.php/consolidated-cause-list/', 1, 'ghc_wp_table_v1',
        '2099-01-01T00:00:00Z', '2099-01-01T00:00:00Z', '2099-01-01T00:00:00Z', '2099-01-01T00:00:00Z');

INSERT OR IGNORE INTO cause_list_documents (id, source_id, title, category_label_raw, category_normalized, listing_date, listing_date_raw, date_parse_status,
  source_url, canonical_url, first_discovered_at, last_seen_at, current_version_id, status, created_at, updated_at)
VALUES ('doc_seed', 'src_seed', 'SYNTHETIC Daily 01/01/2099', 'Daily', 'DAILY', '2099-01-01', '01/01/2099', 'CONFIRMED',
  'https://example.invalid/synthetic-test.pdf', 'https://example.invalid/synthetic-test.pdf', '2099-01-01T00:00:00Z', '2099-01-01T00:00:00Z', 'ver_seed', 'DOWNLOADED', '2099-01-01T00:00:00Z', '2099-01-01T00:00:00Z');

INSERT OR IGNORE INTO document_versions (id, document_id, version_number, sha256, r2_key, content_type, file_size_bytes, page_count, downloaded_at, parser_version, extraction_status)
VALUES ('ver_seed', 'doc_seed', 1, '0000000000000000000000000000000000000000000000000000000000000000', 'synthetic/none.pdf', 'application/pdf', 0, 1, '2099-01-01T00:00:00Z', 'seed', 'EXTRACTED');

INSERT OR IGNORE INTO court_benches (id, court_label_raw, court_number_normalized, bench_label_raw, judges_json, created_at, updated_at)
VALUES ('bench_seed', 'COURT NO: 1', '1', 'DIVISION BENCH-I', '{"judges":["SYNTHETIC JUDGE ONE"],"notes":[],"sitting_time_raw":null}', '2099-01-01T00:00:00Z', '2099-01-01T00:00:00Z');

INSERT OR IGNORE INTO cause_list_entries (id, document_version_id, court_bench_id, serial_number, case_number_raw, case_number_normalized, case_number_key, case_type, case_year,
  listing_date, listing_category_raw, page_start, page_end, raw_text, extraction_method, extraction_confidence, validation_status, entry_index, created_at)
VALUES ('ent_seed', 'ver_seed', 'bench_seed', '1', 'WP(C)/1/2099', 'WP(C)/1/2099', 'WPC12099', 'WP(C)', 2099, '2099-01-01', 'Daily', 1, 1,
  '1 | WP(C)/1/2099 | SYNTHETIC PETITIONER | SYNTHETIC ADVOCATE | SYNTHETIC RESPONDENT', 'TEXT', 1.0, 'VALIDATED', 0, '2099-01-01T00:00:00Z');
INSERT OR IGNORE INTO case_parties (id, cause_list_entry_id, side, party_name_raw, party_name_normalized, sequence_number) VALUES
  ('p_seed_1', 'ent_seed', 'PETITIONER', 'SYNTHETIC PETITIONER', 'SYNTHETIC PETITIONER', 0),
  ('p_seed_2', 'ent_seed', 'RESPONDENT', 'SYNTHETIC RESPONDENT', 'SYNTHETIC RESPONDENT', 1);
INSERT OR IGNORE INTO case_advocates (id, cause_list_entry_id, side, advocate_name_raw, advocate_name_normalized, sequence_number)
VALUES ('a_seed_1', 'ent_seed', 'PETITIONER', 'SYNTHETIC ADVOCATE', 'SYNTHETIC ADVOCATE', 0);
INSERT OR IGNORE INTO document_pages (id, document_version_id, page_number, text_content, extraction_method, page_status)
VALUES ('pg_seed_1', 'ver_seed', 1, 'SYNTHETIC PAGE TEXT', 'TEXT', 'OK');
-- FTS rows are maintained by the ingestion service (not triggers); the seed does the same explicitly.
DELETE FROM cause_list_fts WHERE entry_id = 'ent_seed';
INSERT INTO cause_list_fts (entry_id, case_number, parties, advocates, note, court, raw_text)
VALUES ('ent_seed', 'WP(C)/1/2099 WPC12099', 'SYNTHETIC PETITIONER | SYNTHETIC RESPONDENT', 'SYNTHETIC ADVOCATE', '', 'COURT NO: 1 DIVISION BENCH-I SYNTHETIC JUDGE ONE', '1 | WP(C)/1/2099 | SYNTHETIC PETITIONER');
