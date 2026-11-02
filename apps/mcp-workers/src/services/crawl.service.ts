import type { IngestionMessage } from "@ghc/shared-types";
import { sourceConfigFrom } from "../config/source";
import { assertAllowedUrl } from "../crawler/canonicalize";
import { PoliteFetcher } from "../crawler/fetch";
import { parseSourcePage } from "../crawler/parse-source-page";
import type { AppConfig, Env } from "../env";
import { all, chunk, placeholders, run } from "../repositories/db";
import {
  ensureSource, getLatestVersion, logIngestion, setDocumentStatus, touchSourceAttempt, touchSourceSuccess, upsertDiscoveredDocuments,
} from "../repositories/ingestion.repo";
import type { DocumentRow } from "../repositories/types";
import { AppError } from "../utils/errors";
import { newId } from "../utils/ids";
import { errorFields, logEvent } from "../utils/log";
import { addDays, nowIso, todayUtc } from "../utils/time";

export interface CrawlSummary {
  crawlRunId: string;
  discovered: number;
  newDocuments: number;
  queued: number;
  skippedOutsideWindow: number;
  warnings: string[];
  elapsedMs: number;
  /** Push mode only: documents the runner should now fetch (with validators for conditional requests). */
  toFetch?: Array<{ document_id: string; url: string; etag: string | null; last_modified: string | null; listing_date: string | null; category: string | null }>;
}

export interface CrawlOptions {
  trigger: "cron" | "manual";
  /** Overrides CRAWL_LOOKBACK_DAYS for this run (backfill). */
  lookbackDays?: number;
  fetcher?: PoliteFetcher;
  /** Push mode: the source page HTML was fetched by an external runner; nothing is downloaded or queued here. */
  pushed?: { html: string; finalUrl: string };
  queue?: { sendBatch(msgs: Array<{ body: IngestionMessage }>): Promise<void> };
}

/** Discovery only: parses the source page and enqueues downloads. Downloading/parsing happen in queue consumers. */
export async function runCrawl(env: Env, cfg: AppConfig, opts: CrawlOptions): Promise<CrawlSummary> {
  const t0 = Date.now();
  const source = sourceConfigFrom(cfg);
  const src = await ensureSource(env.DB, source);
  if (!src.enabled) throw new AppError("UNAVAILABLE", "The source is disabled.", 503);

  const runId = newId("crawl");
  const startedAt = nowIso();
  await run(env.DB, `INSERT INTO crawl_runs (id, source_id, trigger, status, started_at) VALUES (?, ?, ?, 'RUNNING', ?)`, runId, src.id, opts.trigger, startedAt);
  await touchSourceAttempt(env.DB, src.id);
  logEvent("info", "crawl.started", { crawl_run_id: runId, trigger: opts.trigger });

  try {
    let html: string;
    let finalUrl: string;
    if (opts.pushed) {
      assertAllowedUrl(opts.pushed.finalUrl, source.allowedHosts);
      ({ html, finalUrl } = opts.pushed);
    } else {
      const fetcher = opts.fetcher ?? new PoliteFetcher(source);
      const res = await fetcher.get(source.sourcePageUrl, { accept: "text/html", maxBytes: 8_000_000 });
      if (res.status !== 200 || !res.body) throw new AppError("UPSTREAM_ERROR", `Source page returned HTTP ${res.status}.`, 502);
      html = new TextDecoder("utf-8").decode(res.body);
      finalUrl = res.finalUrl;
    }
    const parsed = parseSourcePage(html, finalUrl, source.sourceKey, nowIso());
    if (parsed.documents.length === 0) {
      // A structure change must surface as a failure, not as "no cause lists today".
      throw new AppError("UPSTREAM_ERROR", `No cause-list documents were found; the source layout may have changed. ${parsed.warnings.join(" ")}`, 502);
    }

    const outcomes = await upsertDiscoveredDocuments(env.DB, src.id, parsed.documents);
    const newCount = outcomes.filter((o) => o.isNew).length;

    // Decide what to download / re-check.
    const today = todayUtc();
    const lookback = addDays(today, -(opts.lookbackDays ?? cfg.CRAWL_LOOKBACK_DAYS));
    const recheckFrom = addDays(today, -cfg.RECHECK_DAYS);
    const statusRows: DocumentRow[] = [];
    for (const part of chunk(outcomes.map((o) => o.id), 80)) {
      statusRows.push(...(await all<DocumentRow>(env.DB, `SELECT * FROM cause_list_documents WHERE id IN (${placeholders(part.length)})`, ...part)));
    }
    const candidates: DocumentRow[] = [];
    let outside = 0;
    for (const d of statusRows) {
      const rolling = d.category_normalized === "REGULAR_HEARING" && d.listing_date === null; // date-range list, always re-checked
      const inWindow = rolling || (d.listing_date !== null && d.listing_date >= lookback);
      const pending = ["DISCOVERED", "QUEUED", "DOWNLOAD_FAILED"].includes(d.status);
      const recheck = d.status === "DOWNLOADED" && (rolling || (d.listing_date !== null && d.listing_date >= recheckFrom));
      if (!inWindow) { outside++; continue; }
      if (pending || recheck) candidates.push(d);
    }
    candidates.sort((a, b) => (b.listing_date ?? "9999").localeCompare(a.listing_date ?? "9999"));
    const selected = candidates.slice(0, cfg.MAX_DOWNLOADS_PER_CRAWL);

    let toFetch: CrawlSummary["toFetch"];
    if (opts.pushed) {
      toFetch = [];
      for (const d of selected) {
        const v = await getLatestVersion(env.DB, d.id);
        toFetch.push({ document_id: d.id, url: d.source_url, etag: v?.etag ?? null, last_modified: v?.last_modified_header ?? null, listing_date: d.listing_date, category: d.category_normalized });
      }
    } else {
      const sender = opts.queue ?? env.INGESTION_QUEUE;
      for (const part of chunk(selected, 100)) {
        await sender.sendBatch(part.map((d) => ({ body: { type: "DOWNLOAD_AND_STORE", documentId: d.id } as IngestionMessage })));
      }
      for (const d of selected) if (d.status !== "DOWNLOADED") await setDocumentStatus(env.DB, d.id, "QUEUED");
    }

    const elapsed = Date.now() - t0;
    await run(env.DB, `UPDATE crawl_runs SET status = 'SUCCEEDED', completed_at = ?, elapsed_ms = ?, discovered_count = ?, new_count = ?, queued_count = ? WHERE id = ?`,
      nowIso(), elapsed, outcomes.length, newCount, selected.length, runId);
    await touchSourceSuccess(env.DB, src.id);
    await logIngestion(env.DB, null, "info", "crawl.completed", `Discovered ${outcomes.length}, new ${newCount}, queued ${selected.length}`, { crawl_run_id: runId, warnings: parsed.warnings.slice(0, 10) });
    logEvent("info", "crawl.completed", { crawl_run_id: runId, discovered: outcomes.length, new: newCount, queued: selected.length, elapsed_ms: elapsed });
    return { crawlRunId: runId, discovered: outcomes.length, newDocuments: newCount, queued: selected.length, skippedOutsideWindow: outside, warnings: parsed.warnings, elapsedMs: elapsed, ...(toFetch ? { toFetch } : {}) };
  } catch (err) {
    const elapsed = Date.now() - t0;
    await run(env.DB, `UPDATE crawl_runs SET status = 'FAILED', completed_at = ?, elapsed_ms = ?, error_message = ? WHERE id = ?`,
      nowIso(), elapsed, err instanceof Error ? err.message.slice(0, 500) : "unknown", runId);
    await logIngestion(env.DB, null, "error", "crawl.failed", err instanceof Error ? err.message : "crawl failed");
    logEvent("error", "crawl.failed", { crawl_run_id: runId, ...errorFields(err) });
    throw err;
  }
}
