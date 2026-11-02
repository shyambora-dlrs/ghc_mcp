import { ENTRY_PARSED_CATEGORIES, type CategoryNormalized } from "@ghc/shared-types";
import type { AppConfig, Env } from "../env";
import { finishJob, getDocument, getVersion, logIngestion, setVersionStatus, startJob } from "../repositories/ingestion.repo";
import { AppError, notFound } from "../utils/errors";
import { errorFields, logEvent } from "../utils/log";

export type DispatchOutcome = "DISPATCHED" | "NOT_CONFIGURED";

/**
 * Hands a stored PDF version to the Python parser service. The parser pulls the PDF from the Worker's
 * authenticated internal route and posts results back to /internal/versions/:id/parse-result, so no
 * bucket credentials ever leave Cloudflare. If no parser is configured the version simply stays
 * PENDING_PARSE for a runner (CLI / scheduled job) to pick up via GET /internal/pending-parse.
 */
export async function dispatchParse(env: Env, cfg: AppConfig, versionId: string, fetchImpl: typeof fetch = fetch): Promise<DispatchOutcome> {
  const version = await getVersion(env.DB, versionId);
  if (!version) throw notFound("Document version");
  const doc = await getDocument(env.DB, version.document_id);
  if (!doc) throw notFound("Document");

  if (!cfg.INGESTION_SERVICE_URL || !cfg.INGESTION_SERVICE_TOKEN) {
    await logIngestion(env.DB, null, "warn", "parser.not_configured", "INGESTION_SERVICE_URL/TOKEN not set; version left PENDING_PARSE", { version_id: versionId });
    return "NOT_CONFIGURED";
  }

  const jobId = await startJob(env.DB, { jobType: "PARSE_DISPATCH", sourceId: doc.source_id, documentId: doc.id, versionId });
  const base = cfg.APP_BASE_URL.replace(/\/$/, "");
  const category = doc.category_normalized as CategoryNormalized | null;
  try {
    const res = await fetchImpl(`${cfg.INGESTION_SERVICE_URL.replace(/\/$/, "")}/jobs/parse`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.INGESTION_SERVICE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        document_version_id: versionId,
        document_id: doc.id,
        category: category,
        category_label_raw: doc.category_label_raw,
        listing_date: doc.listing_date,
        parse_entries: category ? ENTRY_PARSED_CATEGORIES.includes(category) : false,
        max_pages: cfg.MAX_PDF_PAGES,
        pdf_url: `${base}/internal/versions/${versionId}/pdf`,
        callback_url: `${base}/internal/versions/${versionId}/parse-result`,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 503) {
      // The parser handles one job at a time: "busy" is transient, so ask the queue for a short retry.
      throw new AppError("UNAVAILABLE", "Parser service is busy (HTTP 503).", 503, { retryAfterSeconds: 20 });
    }
    if (res.status !== 202 && res.status !== 200) {
      throw new AppError("UPSTREAM_ERROR", `Parser service rejected the job (HTTP ${res.status}).`, 502);
    }
    await finishJob(env.DB, jobId, "DISPATCHED");
    logEvent("info", "parser.dispatched", { version_id: versionId });
    return "DISPATCHED";
  } catch (err) {
    await finishJob(env.DB, jobId, "FAILED", { code: "DISPATCH_FAILED", message: err instanceof Error ? err.message : "dispatch failed" });
    logEvent("error", "parser.dispatch_failed", { version_id: versionId, ...errorFields(err) });
    throw err;
  }
}

export async function resetForRetry(env: Env, versionId: string): Promise<void> {
  await setVersionStatus(env.DB, versionId, "PENDING_PARSE");
}
