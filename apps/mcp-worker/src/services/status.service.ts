import type { AppConfig, Env } from "../env";
import { all, first } from "../repositories/db";
import { invalid } from "../utils/errors";
import { nowIso } from "../utils/time";

export async function freshnessWarnings(db: D1Database, cfg: AppConfig): Promise<string[]> {
  const src = await first<{ last_successful_at: string | null }>(db, "SELECT last_successful_at FROM sources ORDER BY created_at LIMIT 1");
  if (!src?.last_successful_at) return ["No successful crawl of the official source has been recorded yet; results may be empty or out of date."];
  const hours = (Date.now() - Date.parse(src.last_successful_at)) / 3_600_000;
  return hours > cfg.STALE_AFTER_HOURS
    ? [`Data may be stale: the last successful crawl of the official source was ${Math.floor(hours)} hours ago (${src.last_successful_at}).`]
    : [];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function getIngestionStatus(env: Env, cfg: AppConfig, i: { from_date?: string | null; to_date?: string | null; include_errors?: boolean }, admin = false) {
  for (const d of [i.from_date, i.to_date]) if (d && !ISO_DATE.test(d)) throw invalid("Dates must be YYYY-MM-DD.");
  const db = env.DB;
  const source = await first<{ last_attempted_at: string | null; last_successful_at: string | null; enabled: number }>(db, "SELECT last_attempted_at, last_successful_at, enabled FROM sources ORDER BY created_at LIMIT 1");
  const lastCrawl = await first(db, "SELECT id, trigger, status, started_at, completed_at, elapsed_ms, discovered_count, new_count, queued_count FROM crawl_runs ORDER BY started_at DESC LIMIT 1");
  const range: string[] = [];
  const rp: unknown[] = [];
  if (i.from_date) { range.push("d.listing_date >= ?"); rp.push(i.from_date); }
  if (i.to_date) { range.push("d.listing_date <= ?"); rp.push(i.to_date); }
  const rw = range.length ? `WHERE ${range.join(" AND ")}` : "";

  const docsByStatus = await all<{ status: string; n: number }>(db, `SELECT d.status, COUNT(*) AS n FROM cause_list_documents d ${rw} GROUP BY d.status`, ...rp);
  const versionsByStatus = await all<{ extraction_status: string; n: number }>(
    db, `SELECT v.extraction_status, COUNT(*) AS n FROM cause_list_documents d JOIN document_versions v ON v.id = d.current_version_id ${rw} GROUP BY v.extraction_status`, ...rp);
  const jobs = await first<{ pending: number; running: number; failed_24h: number }>(
    db, `SELECT SUM(CASE WHEN status IN ('PENDING','DISPATCHED') THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN status = 'RUNNING' THEN 1 ELSE 0 END) AS running,
                SUM(CASE WHEN status = 'FAILED' AND created_at >= ? THEN 1 ELSE 0 END) AS failed_24h FROM ingestion_jobs`,
    new Date(Date.now() - 86_400_000).toISOString());
  const ocr = await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM document_pages WHERE extraction_method = 'OCR'");
  const avg = await first<{ ms: number | null }>(db, "SELECT AVG((julianday(completed_at) - julianday(started_at)) * 86400000) AS ms FROM ingestion_jobs WHERE job_type = 'PARSE' AND status = 'SUCCEEDED' AND completed_at IS NOT NULL");
  const ai = await first<{ requests: number; errors: number }>(db, "SELECT COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(errors),0) AS errors FROM ai_usage_daily");
  const warnings = await freshnessWarnings(db, cfg);

  const out: Record<string, unknown> = {
    source: source ?? null,
    last_crawl: lastCrawl,
    data_freshness: { checked_at: nowIso(), stale_after_hours: cfg.STALE_AFTER_HOURS, warnings },
    range: { from_date: i.from_date ?? null, to_date: i.to_date ?? null },
    documents_by_status: Object.fromEntries(docsByStatus.map((r) => [r.status, r.n])),
    current_versions_by_extraction_status: Object.fromEntries(versionsByStatus.map((r) => [r.extraction_status, r.n])),
    jobs: { pending: jobs?.pending ?? 0, running: jobs?.running ?? 0, failed_last_24h: jobs?.failed_24h ?? 0 },
    metrics: { ocr_pages: ocr?.n ?? 0, avg_parse_ms: avg?.ms ? Math.round(avg.ms) : null, groq_requests_total: ai?.requests ?? 0, groq_errors_total: ai?.errors ?? 0 },
    note: "Reflects the ingested dataset only; it is not a guarantee that the Court has published every expected list.",
  };
  if (i.include_errors) {
    const errs = await all<{ job_type: string; document_id: string | null; last_error_code: string | null; last_error_message: string | null; updated_at: string }>(
      db, "SELECT job_type, document_id, last_error_code, last_error_message, updated_at FROM ingestion_jobs WHERE status = 'FAILED' ORDER BY updated_at DESC LIMIT 20");
    // Internal technical detail (messages) is admin-only.
    out.recent_errors = errs.map((e) => (admin ? e : { job_type: e.job_type, document_id: e.document_id, last_error_code: e.last_error_code, updated_at: e.updated_at }));
  }
  return out;
}
