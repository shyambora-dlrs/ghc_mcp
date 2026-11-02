import { handleMcpRequest } from "./mcp/server";
import { loadConfig, type Env } from "./env";
import { handleAdmin } from "./routes/admin";
import { errorResponse, json } from "./routes/http";
import { handleDownload, handleInternal } from "./routes/internal";
import { handleQueue } from "./routes/queue";
import { runCrawl } from "./services/crawl.service";
import { errorFields, logEvent, setLogLevel } from "./utils/log";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    try {
      const cfg = loadConfig(env);
      setLogLevel(cfg.LOG_LEVEL);
      const p = url.pathname;

      if (p === "/mcp") return await handleMcpRequest(req, env);
      if (p === "/health") return json({ status: "ok", service: "ghc-cause-list-mcp" });
      if (p === "/health/ready") {
        const checks: Record<string, boolean> = { database: false, storage: false, queue: Boolean(env.INGESTION_QUEUE) };
        try { await env.DB.prepare("SELECT 1").first(); checks.database = true; } catch { /* reported below */ }
        try { await env.DOCUMENTS_BUCKET.list({ limit: 1 }); checks.storage = true; } catch { /* reported below */ }
        const ok = Object.values(checks).every(Boolean);
        return json({ status: ok ? "ready" : "degraded", checks }, ok ? 200 : 503);
      }
      if (p.startsWith("/admin/")) return await handleAdmin(req, env, cfg, url, ctx);
      if (p.startsWith("/internal/")) return await handleInternal(req, env, cfg, url);
      if (p.startsWith("/download/")) return await handleDownload(env, cfg, url);
      return json({ success: false, error: { code: "NOT_FOUND", message: "Not found." } }, 404);
    } catch (err) {
      logEvent("error", "http.unhandled", { path: url.pathname, ...errorFields(err) });
      return errorResponse(err);
    }
  },

  /** Cron Trigger: discovery only. Downloading and parsing continue asynchronously via the queue. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const cfg = loadConfig(env);
    setLogLevel(cfg.LOG_LEVEL);
    ctx.waitUntil(runCrawl(env, cfg, { trigger: "cron" }).then(() => undefined, (err) => logEvent("error", "cron.crawl_failed", errorFields(err))));
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const cfg = loadConfig(env);
    setLogLevel(cfg.LOG_LEVEL);
    await handleQueue(batch, env, cfg);
  },
} satisfies ExportedHandler<Env>;
