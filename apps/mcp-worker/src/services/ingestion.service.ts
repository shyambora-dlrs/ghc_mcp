import {
  ADVOCATE_SIDES, ENTRY_PARSED_CATEGORIES, PARTY_SIDES, parseResultSchema, normalizeCaseNumber, normalizeCourtNumber,
  normalizeName, type EntryPayload,
} from "@ghc/shared-types";
import type { AppConfig, Env } from "../env";
import { all, batchRun, first, run } from "../repositories/db";
import { auditEvent, finishJob, getDocument, getVersion, logIngestion, startJob } from "../repositories/ingestion.repo";
import { AppError, invalid, notFound } from "../utils/errors";
import { stableId } from "../utils/ids";
import { logEvent } from "../utils/log";
import { nowIso } from "../utils/time";

export interface IngestResult {
  phase: string;
  pages?: number;
  entries?: number;
  extraction_status?: string;
}

/** Applies one phase of a parser callback. Each phase is idempotent; `begin` clears prior derived rows for the version. */
export async function applyParseResult(env: Env, cfg: AppConfig, versionId: string, body: unknown): Promise<IngestResult> {
  const parsed = parseResultSchema.safeParse(body);
  if (!parsed.success) {
    throw invalid(`Invalid parse payload: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const payload = parsed.data;
  const version = await getVersion(env.DB, versionId);
  if (!version) throw notFound("Document version");
  const doc = await getDocument(env.DB, version.document_id);
  if (!doc) throw notFound("Document");

  switch (payload.phase) {
    case "begin": {
      if (payload.page_count > cfg.MAX_PDF_PAGES) {
        throw new AppError("INVALID_INPUT", `PDF has ${payload.page_count} pages; the limit is ${cfg.MAX_PDF_PAGES}.`, 413);
      }
      await db(env).batch([
        db(env).prepare("DELETE FROM document_pages WHERE document_version_id = ?").bind(versionId),
        // Trigger trg_entries_delete_cleanup removes FTS, party and advocate rows.
        db(env).prepare("DELETE FROM cause_list_entries WHERE document_version_id = ?").bind(versionId),
        db(env).prepare("UPDATE document_versions SET parser_version = ?, page_count = ?, extraction_status = 'PENDING_PARSE' WHERE id = ?").bind(payload.parser_version, payload.page_count, versionId),
      ]);
      // The parser acknowledged the dispatched job by starting: the dispatch itself is done.
      await run(env.DB, "UPDATE ingestion_jobs SET status = 'SUCCEEDED', completed_at = ?, updated_at = ? WHERE document_version_id = ? AND job_type = 'PARSE_DISPATCH' AND status = 'DISPATCHED'", nowIso(), nowIso(), versionId);
      await startJob(env.DB, { jobType: "PARSE", sourceId: doc.source_id, documentId: doc.id, versionId });
      await auditEvent(env.DB, "parser", "parse.begin", { type: "document_version", id: versionId }, { parser_version: payload.parser_version });
      logEvent("info", "parser.started", { version_id: versionId, pages: payload.page_count });
      return { phase: "begin" };
    }
    case "chunk": {
      const pageStmts = payload.pages.map((p) =>
        db(env).prepare(
          `INSERT INTO document_pages (id, document_version_id, page_number, text_content, extraction_method, ocr_confidence, page_status)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(document_version_id, page_number) DO UPDATE SET text_content = excluded.text_content,
             extraction_method = excluded.extraction_method, ocr_confidence = excluded.ocr_confidence, page_status = excluded.page_status`,
        ).bind(`pg_${versionId}_${p.page_number}`, versionId, p.page_number, p.text_content, p.extraction_method, p.ocr_confidence, p.page_status),
      );
      await batchRun(env.DB, pageStmts, 40);
      const pageCount = version.page_count ?? Number.MAX_SAFE_INTEGER;
      for (const e of payload.entries) {
        if (e.page_end < e.page_start || e.page_end > pageCount) throw invalid(`Entry ${e.entry_index} has an invalid page range.`);
      }
      const entryStmts: D1PreparedStatement[] = [];
      for (const e of payload.entries) entryStmts.push(...(await buildEntryStatements(env, versionId, doc.listing_date, doc.category_label_raw, e)));
      // Every entry starts with DELETE-by-id, so re-sending a chunk after a partial failure is safe.
      await batchRun(env.DB, entryStmts, 90);
      const ocrPages = payload.pages.filter((p) => p.extraction_method === "OCR").length;
      if (ocrPages) logEvent("info", "parser.ocr_invoked", { version_id: versionId, pages: ocrPages });
      return { phase: "chunk", pages: payload.pages.length, entries: payload.entries.length };
    }
    case "complete": {
      const counts = await first<{ pages: number; entries: number; review: number }>(
        env.DB,
        `SELECT (SELECT COUNT(*) FROM document_pages WHERE document_version_id = ?) AS pages,
                (SELECT COUNT(*) FROM cause_list_entries WHERE document_version_id = ?) AS entries,
                (SELECT COUNT(*) FROM cause_list_entries WHERE document_version_id = ? AND validation_status <> 'VALIDATED') AS review`,
        versionId, versionId, versionId,
      );
      let status = payload.extraction_status;
      const expectsEntries = doc.category_normalized !== null && (ENTRY_PARSED_CATEGORIES as readonly string[]).includes(doc.category_normalized);
      // Never report a clean extraction that produced nothing.
      if (status === "EXTRACTED" && expectsEntries && (counts?.entries ?? 0) === 0) status = "REVIEW_REQUIRED";
      const metadata = { ...payload.metadata, stored_pages: counts?.pages ?? 0, stored_entries: counts?.entries ?? 0, entries_needing_review: counts?.review ?? 0, completed_at: nowIso() };
      await run(env.DB, "UPDATE document_versions SET extraction_status = ?, parser_version = ?, extraction_metadata_json = ? WHERE id = ?", status, payload.parser_version, JSON.stringify(metadata), versionId);
      await finishLatestParseJob(env, versionId, "SUCCEEDED");
      await logIngestion(env.DB, null, "info", "parser.completed", `Version ${versionId} -> ${status}`, { entries: counts?.entries, pages: counts?.pages });
      logEvent("info", "parser.completed", { version_id: versionId, status, entries: counts?.entries, pages: counts?.pages });
      return { phase: "complete", extraction_status: status, entries: counts?.entries ?? 0, pages: counts?.pages ?? 0 };
    }
    case "failed": {
      await run(env.DB, "UPDATE document_versions SET extraction_status = 'FAILED', parser_version = ?, extraction_metadata_json = ? WHERE id = ?", payload.parser_version, JSON.stringify({ error_code: payload.error_code, error_message: payload.error_message }), versionId);
      await finishLatestParseJob(env, versionId, "FAILED", { code: payload.error_code, message: payload.error_message });
      logEvent("error", "parser.failed", { version_id: versionId, error_code: payload.error_code });
      return { phase: "failed", extraction_status: "FAILED" };
    }
  }
}

const db = (env: Env) => env.DB;

async function finishLatestParseJob(env: Env, versionId: string, status: "SUCCEEDED" | "FAILED", err?: { code: string; message: string }) {
  const job = await first<{ id: string }>(env.DB, "SELECT id FROM ingestion_jobs WHERE document_version_id = ? AND job_type = 'PARSE' ORDER BY created_at DESC LIMIT 1", versionId);
  if (job) await finishJob(env.DB, job.id, status, err);
}

/**
 * Builds the statements for one entry: bench, parties, advocates and FTS row.
 * Search-normalized fields are recomputed here from the raw text so the lookup path and the index
 * always agree, regardless of what the parser sent.
 */
async function buildEntryStatements(env: Env, versionId: string, listingDate: string | null, categoryRaw: string | null, e: EntryPayload): Promise<D1PreparedStatement[]> {
  const entryId = await stableId("ent", versionId, e.entry_index);
  const flags = new Set(e.validation_flags);
  const norm = normalizeCaseNumber(e.case_number_raw);
  let validation = e.validation_status;
  if (e.case_number_raw && !norm) { flags.add("CASE_NUMBER_UNNORMALIZED"); if (validation === "VALIDATED") validation = "NEEDS_REVIEW"; }
  if (norm && !norm.yearPlausible) { flags.add("CASE_YEAR_IMPLAUSIBLE"); if (validation === "VALIDATED") validation = "NEEDS_REVIEW"; }
  const now = nowIso();
  const stmts: D1PreparedStatement[] = [];

  let benchId: string | null = null;
  if (e.bench) {
    benchId = await stableId("bench", e.bench.court_label_raw, e.bench.bench_label_raw, e.bench.judges.join("|"), e.bench.sitting_time_raw);
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO court_benches (id, court_label_raw, court_number_normalized, bench_label_raw, judges_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(benchId, e.bench.court_label_raw, normalizeCourtNumber(e.bench.court_label_raw), e.bench.bench_label_raw,
        JSON.stringify({ judges: e.bench.judges, notes: e.bench.notes, sitting_time_raw: e.bench.sitting_time_raw }), now, now),
    );
  }
  stmts.push(env.DB.prepare("DELETE FROM cause_list_entries WHERE id = ?").bind(entryId));
  stmts.push(
    env.DB.prepare(
      `INSERT INTO cause_list_entries (id, document_version_id, court_bench_id, serial_number, item_number, case_number_raw,
         case_number_normalized, case_number_key, case_type, case_year, listing_date, listing_category_raw, listing_note_raw,
         section_heading_raw, connected_cases_json, page_start, page_end, raw_text, extraction_method, extraction_confidence,
         validation_status, validation_flags_json, entry_index, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      entryId, versionId, benchId, e.serial_number, e.item_number, e.case_number_raw, norm?.normalized ?? null, norm?.key ?? null,
      norm?.caseType ?? null, norm?.caseYear ?? null, listingDate, categoryRaw, e.listing_note_raw, e.section_heading_raw,
      e.connected_cases.length ? JSON.stringify(e.connected_cases) : null, e.page_start, e.page_end, e.raw_text,
      e.extraction_method, e.extraction_confidence, validation, JSON.stringify([...flags]), e.entry_index, now,
    ),
  );
  const partyText: string[] = [];
  for (const p of e.parties) {
    const side = (PARTY_SIDES as readonly string[]).includes(p.side) ? p.side : "UNKNOWN";
    const n = normalizeName(p.name_raw);
    partyText.push(n ?? p.name_raw);
    stmts.push(env.DB.prepare(`INSERT INTO case_parties (id, cause_list_entry_id, side, party_name_raw, party_name_normalized, sequence_number) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(`${entryId}_p${p.sequence}_${side}`, entryId, side, p.name_raw, n, p.sequence));
  }
  const advText: string[] = [];
  for (const a of e.advocates) {
    const side = (ADVOCATE_SIDES as readonly string[]).includes(a.side) ? a.side : "UNKNOWN";
    const n = normalizeName(a.name_raw);
    advText.push(n ?? a.name_raw);
    stmts.push(env.DB.prepare(`INSERT INTO case_advocates (id, cause_list_entry_id, side, advocate_name_raw, advocate_name_normalized, sequence_number) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(`${entryId}_a${a.sequence}_${side}`, entryId, side, a.name_raw, n, a.sequence));
  }
  stmts.push(
    env.DB.prepare(
      `INSERT INTO cause_list_fts (entry_id, case_number, parties, advocates, note, court, raw_text) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      entryId, [norm?.normalized, e.case_number_raw, norm?.key].filter(Boolean).join(" "), partyText.join(" | "), advText.join(" | "),
      [e.listing_note_raw, e.section_heading_raw].filter(Boolean).join(" "),
      [e.bench?.court_label_raw, e.bench?.bench_label_raw, ...(e.bench?.judges ?? [])].filter(Boolean).join(" "), e.raw_text,
    ),
  );
  return stmts;
}

export async function pendingParseVersions(env: Env, limit = 20) {
  return all<{ version_id: string; document_id: string; category: string | null; listing_date: string | null }>(
    env.DB,
    `SELECT v.id AS version_id, d.id AS document_id, d.category_normalized AS category, d.listing_date
       FROM document_versions v JOIN cause_list_documents d ON d.id = v.document_id
      WHERE v.extraction_status = 'PENDING_PARSE' AND d.current_version_id = v.id
      ORDER BY COALESCE(d.listing_date, '0000') DESC LIMIT ?`,
    limit,
  );
}
