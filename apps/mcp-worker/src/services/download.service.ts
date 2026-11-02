import type { IngestionMessage } from "@ghc/shared-types";
import { sourceConfigFrom } from "../config/source";
import { PoliteFetcher, type FetchOptions, type FetchResult } from "../crawler/fetch";
import type { AppConfig, Env } from "../env";
import {
  createVersion, finishJob, getDocument, getLatestVersion, logIngestion, setCurrentVersion, setDocumentStatus, startJob,
} from "../repositories/ingestion.repo";
import { run } from "../repositories/db";
import type { VersionRow } from "../repositories/types";
import { assertAllowedUrl } from "../crawler/canonicalize";
import { AppError } from "../utils/errors";
import { sha256Hex } from "../utils/ids";
import { errorFields, logEvent } from "../utils/log";
import { nowIso } from "../utils/time";

export type DownloadOutcome =
  | { kind: "NOT_MODIFIED" }
  | { kind: "UNCHANGED_HASH"; versionId: string }
  | { kind: "NEW_VERSION"; versionId: string; versionNumber: number }
  | { kind: "GONE" };

export function isPdf(bytes: Uint8Array): boolean {
  // "%PDF-" must appear within the first 1024 bytes (the spec allows leading junk).
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

const OK_TYPES = /(application\/pdf|application\/x-pdf|application\/octet-stream|binary\/octet-stream)/i;

/** Anything that can retrieve a source URL: the in-Worker PoliteFetcher, or pre-fetched bytes pushed by a runner. */
export interface SourceFetcher {
  get(url: string, opts?: FetchOptions): Promise<FetchResult>;
}

export interface DownloadDeps {
  fetcher?: SourceFetcher;
  queue?: { send(msg: IngestionMessage): Promise<void> };
}

/** Idempotent: re-delivery of the same message cannot create duplicate versions (UNIQUE(document_id, sha256)). */
export async function downloadAndStore(env: Env, cfg: AppConfig, documentId: string, deps: DownloadDeps = {}, force = false): Promise<DownloadOutcome> {
  const doc = await getDocument(env.DB, documentId);
  if (!doc) throw new AppError("NOT_FOUND", "Document not found.", 404);
  const jobId = await startJob(env.DB, { jobType: "DOWNLOAD_AND_STORE", sourceId: doc.source_id, documentId });
  const t0 = Date.now();
  try {
    const fetcher = deps.fetcher ?? new PoliteFetcher(sourceConfigFrom(cfg));
    const latest = await getLatestVersion(env.DB, documentId);
    const conditional = latest && !force;
    const res = await fetcher.get(doc.source_url, {
      accept: "application/pdf",
      ifNoneMatch: conditional ? latest.etag : null,
      ifModifiedSince: conditional && !latest.etag ? latest.last_modified_header : null,
    });

    if (res.notModified && latest) {
      await run(env.DB, "UPDATE cause_list_documents SET last_seen_at = ?, status = 'DOWNLOADED' WHERE id = ?", nowIso(), documentId);
      await finishJob(env.DB, jobId, "SKIPPED");
      logEvent("info", "document.hash_unchanged", { document_id: documentId, via: "304" });
      return { kind: "NOT_MODIFIED" };
    }
    if (res.status === 404 || res.status === 410) {
      await setDocumentStatus(env.DB, documentId, latest ? "DOWNLOADED" : "DOWNLOAD_FAILED");
      await finishJob(env.DB, jobId, "FAILED", { code: `HTTP_${res.status}`, message: "Source file is not available." });
      await logIngestion(env.DB, jobId, "warn", "document.download_failed", `HTTP ${res.status}`, { document_id: documentId });
      return { kind: "GONE" };
    }
    if (res.status !== 200 || !res.body) throw new AppError("UPSTREAM_ERROR", `Unexpected HTTP ${res.status} from source.`, 502);

    const ctype = res.headers.get("content-type");
    if (ctype && !OK_TYPES.test(ctype) && !isPdf(res.body)) throw new AppError("INVALID_INPUT", `Unexpected content type ${ctype}.`, 415);
    if (!isPdf(res.body)) throw new AppError("INVALID_INPUT", "Downloaded file does not have a PDF signature.", 415);

    const sha = await sha256Hex(res.body);
    const existing = latest && latest.sha256 === sha ? latest : null;
    if (existing) {
      await run(env.DB, "UPDATE cause_list_documents SET last_seen_at = ?, final_url = ?, status = 'DOWNLOADED' WHERE id = ?", nowIso(), res.finalUrl, documentId);
      await finishJob(env.DB, jobId, "SKIPPED");
      logEvent("info", "document.hash_unchanged", { document_id: documentId, sha256: sha.slice(0, 12) });
      return { kind: "UNCHANGED_HASH", versionId: existing.id };
    }

    const key = (n: number) => `ghc/${documentId}/v${n}-${sha.slice(0, 16)}.pdf`;
    const { version, created } = await createVersionAfterStore(env, documentId, sha, res, key);
    if (created) {
      await setCurrentVersion(env.DB, documentId, version.id, res.finalUrl);
      await logIngestion(env.DB, jobId, "info", "document.hash_changed", `Stored version ${version.version_number}`, { document_id: documentId, version_id: version.id, bytes: res.body.byteLength });
      logEvent("info", "document.download_completed", { document_id: documentId, version: version.version_number, bytes: res.body.byteLength, elapsed_ms: Date.now() - t0 });
      await (deps.queue ?? env.INGESTION_QUEUE).send({ type: "PARSE_DOCUMENT_VERSION", documentVersionId: version.id });
    } else {
      await setCurrentVersion(env.DB, documentId, version.id, res.finalUrl);
    }
    await finishJob(env.DB, jobId, "SUCCEEDED");
    return { kind: "NEW_VERSION", versionId: version.id, versionNumber: version.version_number };
  } catch (err) {
    await finishJob(env.DB, jobId, "FAILED", { code: err instanceof AppError ? err.code : "ERROR", message: err instanceof Error ? err.message : "failed" });
    await logIngestion(env.DB, jobId, "error", "document.download_failed", err instanceof Error ? err.message : "failed", { document_id: documentId });
    logEvent("error", "document.download_failed", { document_id: documentId, ...errorFields(err) });
    const latest = await getLatestVersion(env.DB, documentId);
    if (!latest) await setDocumentStatus(env.DB, documentId, "DOWNLOAD_FAILED");
    throw err;
  }
}

async function createVersionAfterStore(
  env: Env, documentId: string, sha: string,
  res: { body: Uint8Array | null; headers: Headers; finalUrl: string },
  key: (n: number) => string,
): Promise<{ version: VersionRow; created: boolean }> {
  const body = res.body!;
  return createVersion(env.DB, {
    documentId, sha256: sha,
    r2KeyFor: key,
    // R2 keys embed the content hash and are never overwritten with different bytes.
    store: async (r2Key) => {
      await env.DOCUMENTS_BUCKET.put(r2Key, body, {
        httpMetadata: { contentType: "application/pdf" },
        customMetadata: { sha256: sha, document_id: documentId },
      });
    },
    contentType: res.headers.get("content-type"),
    size: body.byteLength,
    etag: res.headers.get("etag"),
    lastModified: res.headers.get("last-modified"),
    initialStatus: "PENDING_PARSE",
  });
}

export interface PushedPdf {
  body: Uint8Array;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
  finalUrl: string;
}

/**
 * Push mode: an authorized runner (with a CA bundle that can validate the source's TLS chain) fetched the PDF and
 * hands over the bytes. They go through exactly the same validation, hashing, R2 storage and versioning as a
 * Worker-initiated download.
 */
export async function ingestPushedPdf(env: Env, cfg: AppConfig, documentId: string, pdf: PushedPdf, deps: DownloadDeps = {}): Promise<DownloadOutcome> {
  if (pdf.body.byteLength > cfg.CRAWLER_MAX_DOWNLOAD_BYTES) throw new AppError("INVALID_INPUT", `PDF exceeds the ${cfg.CRAWLER_MAX_DOWNLOAD_BYTES} byte limit.`, 413);
  assertAllowedUrl(pdf.finalUrl, sourceConfigFrom(cfg).allowedHosts);
  const headers = new Headers();
  if (pdf.contentType) headers.set("content-type", pdf.contentType);
  if (pdf.etag) headers.set("etag", pdf.etag);
  if (pdf.lastModified) headers.set("last-modified", pdf.lastModified);
  const fetcher: SourceFetcher = { get: async () => ({ status: 200, finalUrl: pdf.finalUrl, headers, body: pdf.body, notModified: false }) };
  return downloadAndStore(env, cfg, documentId, { ...deps, fetcher }, true);
}
