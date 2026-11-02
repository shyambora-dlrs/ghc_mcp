import type { AppConfig, Env } from "../env";
import { authenticateParser } from "../middleware/auth";
import { getVersion } from "../repositories/ingestion.repo";
import { runCrawl } from "../services/crawl.service";
import { ingestPushedPdf } from "../services/download.service";
import { applyParseResult, pendingParseVersions } from "../services/ingestion.service";
import { verifyDownload } from "../utils/signing";
import { AppError, invalid, notFound } from "../utils/errors";
import { logEvent } from "../utils/log";
import { errorResponse, json, readJson } from "./http";

/** Parser-facing routes: authenticated with PARSER_CALLBACK_TOKEN (distinct from the admin token). */
export async function handleInternal(req: Request, env: Env, cfg: AppConfig, url: URL): Promise<Response> {
  if (!authenticateParser(req, cfg)) {
    return json({ success: false, error: { code: "UNAUTHORIZED", message: "Parser credentials required." } }, 401);
  }
  try {
    let m = /^\/internal\/versions\/([^/]+)\/pdf$/.exec(url.pathname);
    if (req.method === "GET" && m) {
      const v = await getVersion(env.DB, decodeURIComponent(m[1]!));
      if (!v) throw notFound("The document version");
      const obj = await env.DOCUMENTS_BUCKET.get(v.r2_key);
      if (!obj) throw notFound("The stored PDF");
      return new Response(obj.body, { headers: { "content-type": "application/pdf", "content-length": String(obj.size), "x-content-sha256": v.sha256, "cache-control": "no-store" } });
    }
    m = /^\/internal\/versions\/([^/]+)\/parse-result$/.exec(url.pathname);
    if (req.method === "POST" && m) {
      let body: unknown;
      try {
        body = await readJson(req, 8_000_000);
      } catch {
        throw new AppError("INVALID_INPUT", "Payload too large; send smaller chunks.", 413);
      }
      if (body === undefined) throw invalid("Body must be valid JSON.");
      const result = await applyParseResult(env, cfg, decodeURIComponent(m[1]!), body);
      return json({ success: true, ...result });
    }
    // ---- push mode (runner with its own TLS trust store; see docs/source-discovery.md "TLS") ----
    if (req.method === "POST" && url.pathname === "/internal/runner/source-page") {
      let body: unknown;
      try { body = await readJson(req, 8_000_000); } catch { throw new AppError("INVALID_INPUT", "Payload too large.", 413); }
      const b = body as { html?: unknown; final_url?: unknown; lookback_days?: unknown } | undefined;
      if (!b || typeof b.html !== "string" || b.html.length < 100) throw invalid("Body must be JSON: { html: string, final_url?: string }.");
      const lookback = b.lookback_days === undefined || b.lookback_days === null ? undefined : Number(b.lookback_days);
      if (lookback !== undefined && (!Number.isInteger(lookback) || lookback < 0 || lookback > 3650)) throw invalid("lookback_days must be an integer between 0 and 3650.");
      const summary = await runCrawl(env, cfg, { trigger: "manual", lookbackDays: lookback, pushed: { html: b.html, finalUrl: typeof b.final_url === "string" ? b.final_url : cfg.GHC_SOURCE_URL } });
      return json({ success: true, summary });
    }
    m = /^\/internal\/runner\/documents\/([^/]+)\/pdf$/.exec(url.pathname);
    if (req.method === "PUT" && m) {
      const declared = Number(req.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > cfg.CRAWLER_MAX_DOWNLOAD_BYTES) throw new AppError("INVALID_INPUT", "PDF too large.", 413);
      const body = new Uint8Array(await req.arrayBuffer());
      const outcome = await ingestPushedPdf(env, cfg, decodeURIComponent(m[1]!), {
        body, contentType: req.headers.get("content-type"), etag: req.headers.get("x-source-etag"),
        lastModified: req.headers.get("x-source-last-modified"), finalUrl: req.headers.get("x-source-final-url") ?? "",
      });
      return json({ success: true, outcome });
    }
    if (req.method === "GET" && url.pathname === "/internal/pending-parse") {
      return json({ success: true, versions: await pendingParseVersions(env, Math.min(100, Number(url.searchParams.get("limit") ?? 20))) });
    }
    throw new AppError("NOT_FOUND", "Unknown internal route.", 404);
  } catch (err) {
    logEvent("warn", "internal.request_failed", { path: url.pathname, code: err instanceof AppError ? err.code : "INTERNAL" });
    return errorResponse(err);
  }
}

/** Public signed-link download of a stored original PDF. */
export async function handleDownload(env: Env, cfg: AppConfig, url: URL): Promise<Response> {
  const m = /^\/download\/([^/]+)$/.exec(url.pathname);
  if (!m) return json({ success: false, error: { code: "NOT_FOUND", message: "Not found." } }, 404);
  const versionId = decodeURIComponent(m[1]!);
  if (!(await verifyDownload(cfg.DOWNLOAD_SIGNING_SECRET, versionId, url.searchParams.get("exp"), url.searchParams.get("sig")))) {
    return json({ success: false, error: { code: "FORBIDDEN", message: "The download link is invalid or has expired." } }, 403);
  }
  const v = await getVersion(env.DB, versionId);
  const obj = v ? await env.DOCUMENTS_BUCKET.get(v.r2_key) : null;
  if (!v || !obj) return json({ success: false, error: { code: "NOT_FOUND", message: "Not found." } }, 404);
  return new Response(obj.body, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${v.id}.pdf"`, "cache-control": "private, max-age=60", "x-content-sha256": v.sha256 } });
}
