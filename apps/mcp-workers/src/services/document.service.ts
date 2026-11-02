import type { AppConfig, Env } from "../env";
import { all, first } from "../repositories/db";
import { getDocument, getVersion } from "../repositories/ingestion.repo";
import type { DocumentRow, VersionRow } from "../repositories/types";
import { invalid, notFound } from "../utils/errors";
import { signDownload } from "../utils/signing";

export interface DocumentDetails {
  document: {
    document_id: string; title: string | null; category_label_raw: string | null; category_normalized: string | null;
    listing_date: string | null; listing_date_raw: string | null; date_parse_status: string; publication_label: string | null;
    source_url: string; final_url: string | null; status: string; first_discovered_at: string; last_seen_at: string;
  };
  version: null | {
    version_id: string; version_number: number; sha256: string; file_size_bytes: number | null; page_count: number | null;
    content_type: string | null; etag: string | null; last_modified_header: string | null; downloaded_at: string;
    parser_version: string | null; extraction_status: string; extraction_metadata: unknown;
    is_current: boolean; r2_object_available: boolean;
    page_status_counts: Record<string, number>; entry_count: number;
  };
  versions: Array<{ version_id: string; version_number: number; sha256: string; downloaded_at: string; extraction_status: string; is_current: boolean }>;
  download: null | { url_path: string; expires_at: string; note: string };
}

export async function getDocumentDetails(env: Env, cfg: AppConfig, documentId: string, versionId?: string | null): Promise<DocumentDetails> {
  const doc: DocumentRow | null = await getDocument(env.DB, documentId);
  if (!doc) throw notFound("The document");
  const versions = await all<VersionRow>(env.DB, "SELECT * FROM document_versions WHERE document_id = ? ORDER BY version_number DESC", documentId);
  let selected: VersionRow | undefined;
  if (versionId) {
    selected = versions.find((v) => v.id === versionId);
    if (!selected) throw invalid("version_id does not belong to this document.");
  } else {
    selected = versions.find((v) => v.id === doc.current_version_id) ?? versions[0];
  }

  let version: DocumentDetails["version"] = null;
  let download: DocumentDetails["download"] = null;
  if (selected) {
    const head = await env.DOCUMENTS_BUCKET.head(selected.r2_key).catch(() => null);
    const pageCounts = await all<{ page_status: string; n: number }>(env.DB, "SELECT page_status, COUNT(*) AS n FROM document_pages WHERE document_version_id = ? GROUP BY page_status", selected.id);
    const entryCount = (await first<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM cause_list_entries WHERE document_version_id = ?", selected.id))?.n ?? 0;
    let meta: unknown = null;
    try { meta = selected.extraction_metadata_json ? JSON.parse(selected.extraction_metadata_json) : null; } catch { /* malformed metadata is ignored */ }
    version = {
      version_id: selected.id, version_number: selected.version_number, sha256: selected.sha256,
      file_size_bytes: selected.file_size_bytes, page_count: selected.page_count, content_type: selected.content_type,
      etag: selected.etag, last_modified_header: selected.last_modified_header, downloaded_at: selected.downloaded_at,
      parser_version: selected.parser_version, extraction_status: selected.extraction_status, extraction_metadata: meta,
      is_current: selected.id === doc.current_version_id, r2_object_available: head !== null,
      page_status_counts: Object.fromEntries(pageCounts.map((p) => [p.page_status, p.n])), entry_count: entryCount,
    };
    if (head && cfg.DOWNLOAD_SIGNING_SECRET) {
      const s = await signDownload(cfg.DOWNLOAD_SIGNING_SECRET, selected.id, cfg.DOWNLOAD_LINK_TTL_SECONDS);
      download = {
        url_path: `${cfg.APP_BASE_URL.replace(/\/$/, "")}${s.path}`,
        expires_at: new Date(s.exp * 1000).toISOString(),
        note: "Short-lived link to the stored copy of the original PDF. The official source URL remains the authoritative reference.",
      };
    }
  }
  return {
    document: {
      document_id: doc.id, title: doc.title, category_label_raw: doc.category_label_raw, category_normalized: doc.category_normalized,
      listing_date: doc.listing_date, listing_date_raw: doc.listing_date_raw, date_parse_status: doc.date_parse_status,
      publication_label: doc.publication_label, source_url: doc.source_url, final_url: doc.final_url, status: doc.status,
      first_discovered_at: doc.first_discovered_at, last_seen_at: doc.last_seen_at,
    },
    version,
    versions: versions.map((v) => ({ version_id: v.id, version_number: v.version_number, sha256: v.sha256, downloaded_at: v.downloaded_at, extraction_status: v.extraction_status, is_current: v.id === doc.current_version_id })),
    download,
  };
}

export async function getDocumentPage(db: D1Database, versionId: string, pageNumber: number) {
  const row = await first<{
    page_number: number; text_content: string | null; extraction_method: string; ocr_confidence: number | null; page_status: string;
    document_id: string; version_number: number; sha256: string; page_count: number | null; source_url: string; title: string | null; extraction_status: string;
  }>(
    db,
    `SELECT p.page_number, p.text_content, p.extraction_method, p.ocr_confidence, p.page_status, v.document_id, v.version_number,
            v.sha256, v.page_count, v.extraction_status, d.source_url, d.title
       FROM document_pages p JOIN document_versions v ON v.id = p.document_version_id JOIN cause_list_documents d ON d.id = v.document_id
      WHERE p.document_version_id = ? AND p.page_number = ?`,
    versionId, pageNumber,
  );
  if (row) return { ...row, document_version_id: versionId };
  const v = await getVersion(db, versionId);
  if (!v) throw notFound("The document version");
  if (v.page_count !== null && (pageNumber < 1 || pageNumber > v.page_count)) throw invalid(`page_number must be between 1 and ${v.page_count} (pages are 1-based).`);
  throw notFound(`Page ${pageNumber} (it may not have been parsed yet; extraction status is ${v.extraction_status})`);
}
