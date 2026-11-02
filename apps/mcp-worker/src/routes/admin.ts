import type { AppConfig, Env } from "../env";
import { authenticateAdmin } from "../middleware/auth";
import { all, first } from "../repositories/db";
import { auditEvent, getDocument, getLatestVersion } from "../repositories/ingestion.repo";
import { runCrawl } from "../services/crawl.service";
import { listDocuments } from "../services/search.service";
import { getIngestionStatus } from "../services/status.service";
import { AppError, invalid, notFound } from "../utils/errors";
import { errorResponse, json, readJson } from "./http";

export async function handleAdmin(req: Request, env: Env, cfg: AppConfig, url: URL, ctx: ExecutionContext): Promise<Response> {
  if (!authenticateAdmin(req, cfg)) {
    return json({ success: false, error: { code: "UNAUTHORIZED", message: "Admin credentials required." } }, 401, { "www-authenticate": 'Bearer realm="ghc-admin"' });
  }
  try {
    const path = url.pathname.replace(/\/+$/, "");
    const m = req.method;

    if (m === "GET" && path === "/admin/ingestion/status") {
      return json(await getIngestionStatus(env, cfg, { from_date: url.searchParams.get("from_date"), to_date: url.searchParams.get("to_date"), include_errors: true }, true));
    }
    if (m === "POST" && path === "/admin/ingestion/crawl") {
      const body = ((await readJson(req, 10_000)) ?? {}) as { lookback_days?: unknown; wait?: unknown };
      const lookback = body.lookback_days === undefined ? undefined : Number(body.lookback_days);
      if (lookback !== undefined && (!Number.isInteger(lookback) || lookback < 0 || lookback > 3650)) throw invalid("lookback_days must be an integer between 0 and 3650.");
      await auditEvent(env.DB, "admin", "crawl.manual_trigger", { type: "source", id: "ghc" }, { lookback_days: lookback ?? null });
      // Discovery can take a while (polite rate limit); run it after responding unless the caller asks to wait.
      const job = runCrawl(env, cfg, { trigger: "manual", lookbackDays: lookback });
      if (body.wait === true) return json({ success: true, summary: await job });
      ctx.waitUntil(job.catch(() => undefined));
      return json({ success: true, accepted: true, note: "Crawl started; follow progress at GET /admin/ingestion/status." }, 202);
    }
    let mm = /^\/admin\/ingestion\/documents\/([^/]+)\/retry$/.exec(path);
    if (m === "POST" && mm) {
      const id = decodeURIComponent(mm[1]!);
      const doc = await getDocument(env.DB, id);
      if (!doc) throw notFound("The document");
      const latest = await getLatestVersion(env.DB, id);
      await auditEvent(env.DB, "admin", "document.retry", { type: "document", id });
      if (latest && ["FAILED", "REVIEW_REQUIRED", "PENDING_PARSE", "OCR_REQUIRED", "PARTIALLY_EXTRACTED"].includes(latest.extraction_status)) {
        await env.INGESTION_QUEUE.send({ type: "RETRY_DOCUMENT", documentVersionId: latest.id, reason: "admin retry" });
        return json({ success: true, queued: "RETRY_DOCUMENT", version_id: latest.id }, 202);
      }
      await env.INGESTION_QUEUE.send({ type: "DOWNLOAD_AND_STORE", documentId: id, force: true });
      return json({ success: true, queued: "DOWNLOAD_AND_STORE" }, 202);
    }
    if (m === "GET" && path === "/admin/documents") {
      const page = await listDocuments(env.DB, { listing_date: url.searchParams.get("date"), category: url.searchParams.get("category"), limit: Number(url.searchParams.get("limit") ?? 50), cursor: url.searchParams.get("cursor") });
      return json({ success: true, ...page });
    }
    if (m === "GET" && path === "/admin/jobs") {
      const status = url.searchParams.get("status");
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
      const rows = await all(env.DB, `SELECT * FROM ingestion_jobs ${status ? "WHERE status = ?" : ""} ORDER BY created_at DESC LIMIT ?`, ...(status ? [status] : []), limit);
      return json({ success: true, jobs: rows });
    }
    mm = /^\/admin\/jobs\/([^/]+)$/.exec(path);
    if (m === "GET" && mm) {
      const id = decodeURIComponent(mm[1]!);
      const job = await first(env.DB, "SELECT * FROM ingestion_jobs WHERE id = ?", id);
      if (!job) throw notFound("The job");
      const logs = await all(env.DB, "SELECT level, event_type, message, metadata_json, created_at FROM ingestion_logs WHERE job_id = ? ORDER BY created_at LIMIT 200", id);
      return json({ success: true, job, logs });
    }
    throw new AppError("NOT_FOUND", "Unknown admin route.", 404);
  } catch (err) {
    return errorResponse(err);
  }
}
