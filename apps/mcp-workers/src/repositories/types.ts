export interface SourceRow {
  id: string;
  source_key: string;
  name: string;
  source_page_url: string;
  enabled: number;
  crawler_adapter: string;
  last_attempted_at: string | null;
  last_successful_at: string | null;
}

export interface DocumentRow {
  id: string;
  source_id: string;
  title: string | null;
  category_label_raw: string | null;
  category_normalized: string | null;
  listing_date: string | null;
  listing_date_raw: string | null;
  date_parse_status: string;
  source_url: string;
  canonical_url: string;
  final_url: string | null;
  source_filename: string | null;
  court_or_establishment_label: string | null;
  publication_label: string | null;
  discovery_metadata_json: string | null;
  first_discovered_at: string;
  last_seen_at: string;
  current_version_id: string | null;
  status: string;
}

export interface VersionRow {
  id: string;
  document_id: string;
  version_number: number;
  sha256: string;
  r2_key: string;
  content_type: string | null;
  file_size_bytes: number | null;
  page_count: number | null;
  etag: string | null;
  last_modified_header: string | null;
  downloaded_at: string;
  parser_version: string | null;
  extraction_status: string;
  extraction_metadata_json: string | null;
}
