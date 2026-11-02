import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { join } from "node:path";
import type { IngestionMessage, EntryPayload } from "@ghc/shared-types";
import { loadConfig, type Env } from "../src/env";
import { applyParseResult } from "../src/services/ingestion.service";
import { createVersion, ensureSource, setCurrentVersion, upsertDiscoveredDocuments } from "../src/repositories/ingestion.repo";
import type { DiscoveredCauseListDocument } from "../src/crawler/types";
import { sha256Hex } from "../src/utils/ids";

const MIGRATIONS = join(import.meta.dirname, "../../../database/migrations");

type Param = string | number | bigint | null | Uint8Array;
const coerce = (p: unknown): Param => (p === undefined || p === null ? null : typeof p === "boolean" ? (p ? 1 : 0) : (p as Param));

class Stmt {
  private params: Param[] = [];
  constructor(private readonly sql: string, private readonly raw: StatementSync) {}
  bind(...p: unknown[]) { this.params = p.map(coerce); return this; }
  async all<T>() { const results = this.raw.all(...this.params).map((r) => ({ ...r })) as T[]; return { results, success: true, meta: {} }; }
  async first<T>(col?: string) { const r = this.raw.get(...this.params); if (!r) return null; return (col ? (r as Record<string, unknown>)[col] : { ...r }) as T; }
  async run() { const r = this.raw.run(...this.params); return { success: true, meta: { changes: Number(r.changes) }, results: [] }; }
  execSync() { return this.raw.run(...this.params); }
  get text() { return this.sql; }
}

/** Minimal D1Database stand-in on real SQLite (same engine and FTS5 as D1). Statements in batch() are atomic. */
export class TestD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  statementLog: string[] = [];
  constructor() {
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) this.sqlite.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  }
  prepare(sql: string) { this.statementLog.push(sql); return new Stmt(sql, this.sqlite.prepare(sql)) as unknown as D1PreparedStatement; }
  async batch(stmts: D1PreparedStatement[]) {
    this.sqlite.exec("BEGIN");
    try {
      const out = [];
      for (const s of stmts) out.push((s as unknown as Stmt).execSync());
      this.sqlite.exec("COMMIT");
      return out.map(() => ({ success: true, meta: {}, results: [] }));
    } catch (e) { this.sqlite.exec("ROLLBACK"); throw e; }
  }
}

export class FakeR2 {
  store = new Map<string, Uint8Array>();
  puts = 0;
  async put(key: string, value: Uint8Array | ArrayBuffer | string) {
    this.puts++;
    this.store.set(key, typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value as ArrayBuffer));
    return {};
  }
  async get(key: string) {
    const v = this.store.get(key);
    if (!v) return null;
    return { body: new Blob([v as unknown as ArrayBuffer]).stream(), size: v.byteLength, arrayBuffer: async () => v.buffer };
  }
  async head(key: string) { return this.store.has(key) ? { key, size: this.store.get(key)!.byteLength } : null; }
  async list() { return { objects: [...this.store.keys()].map((key) => ({ key })), truncated: false }; }
}

export class FakeQueue {
  sent: IngestionMessage[] = [];
  async send(m: IngestionMessage) { this.sent.push(m); }
  async sendBatch(ms: Array<{ body: IngestionMessage }>) { this.sent.push(...ms.map((m) => m.body)); }
}

export function makeEnv(vars: Record<string, string | boolean> = {}) {
  const db = new TestD1();
  const r2 = new FakeR2();
  const queue = new FakeQueue();
  const env = { DB: db as unknown as D1Database, DOCUMENTS_BUCKET: r2 as unknown as R2Bucket, INGESTION_QUEUE: queue as unknown as Queue<IngestionMessage>, APP_ENV: "test", ...vars } as Env;
  return { env, db, r2, queue, cfg: loadConfig(env) };
}
export type TestEnv = ReturnType<typeof makeEnv>;

export const SRC = { sourceKey: "ghc_consolidated_cause_list", sourceName: "Gauhati High Court Consolidated Cause List", sourcePageUrl: "https://ghconline.gov.in/index.php/consolidated-cause-list/", enabled: true, crawlerAdapter: "ghc_wp_table_v1" };

export function discovered(over: Partial<DiscoveredCauseListDocument> & { canonicalUrl: string }): DiscoveredCauseListDocument {
  return {
    sourceKey: SRC.sourceKey, title: "Daily 03/11/2026", categoryLabelRaw: "Daily", categoryNormalized: "DAILY", listingDate: "2026-11-03",
    listingDateRaw: "03/11/2026", dateParseStatus: "CONFIRMED", sourceUrl: over.canonicalUrl, discoveredAt: new Date().toISOString(), discoveryMetadata: {}, ...over,
  };
}

export const PDF_BYTES = (tag: string) => new TextEncoder().encode(`%PDF-1.7\n% synthetic test file ${tag}\n%%EOF\n`);

export interface SeedEntry {
  idx: number; serial?: string; caseNo: string | null; page?: number; court?: string; bench?: string; judges?: string[];
  petitioner?: string; respondent?: string; padv?: string[]; radv?: string[]; note?: string; heading?: string; validation?: "VALIDATED" | "NEEDS_REVIEW" | "UNPARSED";
}

export function entryPayload(e: SeedEntry): EntryPayload {
  const parties = [] as EntryPayload["parties"];
  if (e.petitioner) parties.push({ name_raw: e.petitioner, side: "PETITIONER", sequence: 0 });
  if (e.respondent) parties.push({ name_raw: e.respondent, side: "RESPONDENT", sequence: 1 });
  const advocates = [
    ...(e.padv ?? []).map((n, i) => ({ name_raw: n, side: "PETITIONER", sequence: i })),
    ...(e.radv ?? []).map((n, i) => ({ name_raw: n, side: "RESPONDENT", sequence: i })),
  ];
  return {
    entry_index: e.idx, bench: e.court ? { court_label_raw: e.court, bench_label_raw: e.bench ?? null, judges: e.judges ?? [], notes: [], sitting_time_raw: null } : null,
    serial_number: e.serial ?? String(e.idx + 1), item_number: null, case_number_raw: e.caseNo, listing_note_raw: e.note ?? null,
    section_heading_raw: e.heading ?? null, connected_cases: [], page_start: e.page ?? 1, page_end: e.page ?? 1,
    raw_text: `${e.serial ?? e.idx + 1} ${e.caseNo ?? ""} ${e.petitioner ?? ""} Versus ${e.respondent ?? ""}`.trim(),
    extraction_method: "TEXT", extraction_confidence: 0.95, validation_status: e.validation ?? "VALIDATED", validation_flags: [], parties, advocates,
  };
}

/** Creates a document + stored version, and loads entries through the real parser-callback path. */
export async function seedDocument(t: TestEnv, o: {
  url: string; date?: string | null; category?: string; label?: string; entries: SeedEntry[]; pages?: number; bytesTag?: string; title?: string; status?: string;
}): Promise<{ documentId: string; versionId: string }> {
  const src = await ensureSource(t.env.DB, SRC);
  const [outcome] = await upsertDiscoveredDocuments(t.env.DB, src.id, [discovered({
    canonicalUrl: o.url, title: o.title ?? `${o.label ?? "Daily"} ${o.date}`, listingDate: o.date === undefined ? "2026-11-03" : o.date,
    categoryNormalized: (o.category ?? "DAILY") as never, categoryLabelRaw: o.label ?? "Daily",
  })]);
  const documentId = outcome!.id;
  const bytes = PDF_BYTES(o.bytesTag ?? o.url);
  const sha = await sha256Hex(bytes);
  const { version } = await createVersion(t.env.DB, {
    documentId, sha256: sha, r2KeyFor: (n) => `ghc/${documentId}/v${n}-${sha.slice(0, 16)}.pdf`, store: async (k) => { await t.env.DOCUMENTS_BUCKET.put(k, bytes); },
    contentType: "application/pdf", size: bytes.byteLength, etag: null, lastModified: null, initialStatus: "PENDING_PARSE",
  });
  await setCurrentVersion(t.env.DB, documentId, version.id, o.url);
  const pages = o.pages ?? Math.max(1, ...o.entries.map((e) => e.page ?? 1));
  await applyParseResult(t.env, t.cfg, version.id, { phase: "begin", parser_version: "test-1", page_count: pages });
  await applyParseResult(t.env, t.cfg, version.id, {
    phase: "chunk", parser_version: "test-1",
    pages: Array.from({ length: pages }, (_, i) => ({ page_number: i + 1, text_content: `page ${i + 1} text`, extraction_method: "TEXT", ocr_confidence: null, page_status: "OK" })),
    entries: o.entries.map(entryPayload),
  });
  await applyParseResult(t.env, t.cfg, version.id, { phase: "complete", parser_version: "test-1", extraction_status: "EXTRACTED", metadata: {} });
  return { documentId, versionId: version.id };
}
