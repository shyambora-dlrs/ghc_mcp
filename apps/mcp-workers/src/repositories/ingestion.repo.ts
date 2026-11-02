import type { DiscoveredCauseListDocument } from "../crawler/types";
import { newId, stableId } from "../utils/ids";
import { nowIso } from "../utils/time";
import { IN_CHUNK, all, batchRun, chunk, first, placeholders, run } from "./db";
import type { DocumentRow, SourceRow, VersionRow } from "./types";

export async function ensureSource(
  db: D1Database,
  s: { sourceKey: string; sourceName: string; sourcePageUrl: string; enabled: boolean; crawlerAdapter: string },
): Promise<SourceRow> {
  const now = nowIso();
  const id = await stableId("src", s.sourceKey);
  await run(
    db,
    `INSERT INTO sources (id, source_key, name, source_page_url, enabled, crawler_adapter, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_key) DO UPDATE SET name = excluded.name, source_page_url = excluded.source_page_url,
       crawler_adapter = excluded.crawler_adapter, updated_at = excluded.updated_at`,
    id, s.sourceKey, s.sourceName, s.sourcePageUrl, s.enabled ? 1 : 0, s.crawlerAdapter, now, now,
  );
  return (await first<SourceRow>(db, "SELECT * FROM sources WHERE source_key = ?", s.sourceKey))!;
}

export const touchSourceAttempt = (db: D1Database, id: string) =>
  run(db, "UPDATE sources SET last_attempted_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), id);
export const touchSourceSuccess = (db: D1Database, id: string) =>
  run(db, "UPDATE sources SET last_successful_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), id);

export interface UpsertOutcome {
  id: string;
  isNew: boolean;
  doc: DiscoveredCauseListDocument;
}

/** Idempotent upsert keyed on (source, canonical URL). Existing documents keep their history; only discovery metadata refreshes. */
export async function upsertDiscoveredDocuments(
  db: D1Database,
  sourceId: string,
  docs: DiscoveredCauseListDocument[],
): Promise<UpsertOutcome[]> {
  const withIds = await Promise.all(docs.map(async (doc) => ({ doc, id: await stableId("doc", sourceId, doc.canonicalUrl) })));
  const existing = new Set<string>();
  for (const part of chunk(withIds, IN_CHUNK)) {
    const rows = await all<{ id: string }>(
      db,
      `SELECT id FROM cause_list_documents WHERE id IN (${placeholders(part.length)})`,
      ...part.map((p) => p.id),
    );
    rows.forEach((r) => existing.add(r.id));
  }
  const now = nowIso();
  const stmts = withIds.map(({ doc, id }) =>
    db
      .prepare(
        `INSERT INTO cause_list_documents (id, source_id, title, category_label_raw, category_normalized, listing_date,
           listing_date_raw, date_parse_status, source_url, canonical_url, source_filename, court_or_establishment_label,
           publication_label, discovery_metadata_json, first_discovered_at, last_seen_at, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DISCOVERED', ?, ?)
         ON CONFLICT(source_id, canonical_url) DO UPDATE SET
           title = excluded.title, category_label_raw = excluded.category_label_raw,
           category_normalized = excluded.category_normalized, listing_date = excluded.listing_date,
           listing_date_raw = excluded.listing_date_raw, date_parse_status = excluded.date_parse_status,
           publication_label = excluded.publication_label, discovery_metadata_json = excluded.discovery_metadata_json,
           last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at`,
      )
      .bind(
        id, sourceId, doc.title, doc.categoryLabelRaw, doc.categoryNormalized, doc.listingDate, doc.listingDateRaw,
        doc.dateParseStatus, doc.sourceUrl, doc.canonicalUrl, doc.sourceFilename ?? null,
        doc.courtOrEstablishmentLabel ?? null, doc.publicationLabel ?? null, JSON.stringify(doc.discoveryMetadata),
        doc.discoveredAt, now, now, now,
      ),
  );
  await batchRun(db, stmts, 40);
  return withIds.map(({ doc, id }) => ({ id, isNew: !existing.has(id), doc }));
}

export const getDocument = (db: D1Database, id: string) =>
  first<DocumentRow>(db, "SELECT * FROM cause_list_documents WHERE id = ?", id);

export const setDocumentStatus = (db: D1Database, id: string, status: string) =>
  run(db, "UPDATE cause_list_documents SET status = ?, updated_at = ? WHERE id = ?", status, nowIso(), id);

export async function getDocumentsByIds(db: D1Database, ids: string[]): Promise<Map<string, DocumentRow>> {
  const map = new Map<string, DocumentRow>();
  for (const part of chunk(ids, IN_CHUNK)) {
    const rows = await all<DocumentRow>(
      db,
      `SELECT * FROM cause_list_documents WHERE id IN (${placeholders(part.length)})`,
      ...part,
    );
    rows.forEach((r) => map.set(r.id, r));
  }
  return map;
}

export const getVersion = (db: D1Database, id: string) =>
  first<VersionRow>(db, "SELECT * FROM document_versions WHERE id = ?", id);

export const getLatestVersion = (db: D1Database, documentId: string) =>
  first<VersionRow>(
    db,
    "SELECT * FROM document_versions WHERE document_id = ? ORDER BY version_number DESC LIMIT 1",
    documentId,
  );

export const getVersionBySha = (db: D1Database, documentId: string, sha: string) =>
  first<VersionRow>(db, "SELECT * FROM document_versions WHERE document_id = ? AND sha256 = ?", documentId, sha);

/**
 * Creates the next immutable version. Race-safe: version_number is computed inside the INSERT and
 * UNIQUE(document_id, sha256) turns a duplicate delivery into a no-op.
 */
export async function createVersion(
  db: D1Database,
  v: {
    documentId: string; sha256: string; r2KeyFor: (versionNumber: number) => string;
    /** Called with the final R2 key BEFORE the row is inserted, so a row never points at a missing object. */
    store: (r2Key: string) => Promise<void>;
    contentType: string | null; size: number; etag: string | null; lastModified: string | null; initialStatus: string;
  },
): Promise<{ version: VersionRow; created: boolean }> {
  const existing = await getVersionBySha(db, v.documentId, v.sha256);
  if (existing) return { version: existing, created: false };
  const next = ((await first<{ n: number | null }>(db, "SELECT MAX(version_number) AS n FROM document_versions WHERE document_id = ?", v.documentId))?.n ?? 0) + 1;
  const id = await stableId("ver", v.documentId, v.sha256);
  const r2Key = v.r2KeyFor(next);
  await v.store(r2Key);
  await run(
    db,
    `INSERT INTO document_versions (id, document_id, version_number, sha256, r2_key, content_type, file_size_bytes,
       etag, last_modified_header, downloaded_at, extraction_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(document_id, sha256) DO NOTHING`,
    id, v.documentId, next, v.sha256, r2Key, v.contentType, v.size, v.etag, v.lastModified, nowIso(), v.initialStatus,
  );
  const version = (await getVersionBySha(db, v.documentId, v.sha256))!;
  return { version, created: version.id === id };
}

export const setCurrentVersion = (db: D1Database, documentId: string, versionId: string, finalUrl: string | null) =>
  run(
    db,
    `UPDATE cause_list_documents SET current_version_id = ?, final_url = ?, status = 'DOWNLOADED', updated_at = ? WHERE id = ?`,
    versionId, finalUrl, nowIso(), documentId,
  );

export const setVersionStatus = (db: D1Database, versionId: string, status: string) =>
  run(db, "UPDATE document_versions SET extraction_status = ? WHERE id = ?", status, versionId);

// ---- jobs & logs ---------------------------------------------------------------------------

export type JobStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED" | "DISPATCHED";

export async function startJob(
  db: D1Database,
  j: { jobType: string; sourceId?: string | null; documentId?: string | null; versionId?: string | null },
): Promise<string> {
  const id = newId("job");
  const now = nowIso();
  await run(
    db,
    `INSERT INTO ingestion_jobs (id, source_id, document_id, document_version_id, job_type, status, attempt_count,
       started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'RUNNING', 1, ?, ?, ?)`,
    id, j.sourceId ?? null, j.documentId ?? null, j.versionId ?? null, j.jobType, now, now, now,
  );
  return id;
}

export async function finishJob(
  db: D1Database,
  id: string,
  status: JobStatus,
  err?: { code: string; message: string },
): Promise<void> {
  const now = nowIso();
  await run(
    db,
    `UPDATE ingestion_jobs SET status = ?, completed_at = CASE WHEN ? IN ('SUCCEEDED','FAILED','SKIPPED') THEN ? ELSE NULL END,
       last_error_code = ?, last_error_message = ?, updated_at = ? WHERE id = ?`,
    status, status, now, err?.code ?? null, err?.message?.slice(0, 1000) ?? null, now, id,
  );
}

export async function logIngestion(
  db: D1Database,
  jobId: string | null,
  level: "debug" | "info" | "warn" | "error",
  eventType: string,
  message: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await run(
    db,
    `INSERT INTO ingestion_logs (id, job_id, level, event_type, message, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    newId("log"), jobId, level, eventType, message.slice(0, 1000), metadata ? JSON.stringify(metadata).slice(0, 4000) : null, nowIso(),
  );
}

export async function auditEvent(
  db: D1Database,
  actor: string,
  event: string,
  target?: { type: string; id: string },
  metadata?: Record<string, unknown>,
): Promise<void> {
  await run(
    db,
    `INSERT INTO audit_events (id, actor_type, event_type, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    newId("aud"), actor, event, target?.type ?? null, target?.id ?? null, metadata ? JSON.stringify(metadata) : null, nowIso(),
  );
}
