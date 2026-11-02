import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sourceConfigFrom } from "../../src/config/source";
import { PoliteFetcher } from "../../src/crawler/fetch";
import { handleQueue } from "../../src/routes/queue";
import { runCrawl } from "../../src/services/crawl.service";
import { downloadAndStore } from "../../src/services/download.service";
import { applyParseResult } from "../../src/services/ingestion.service";
import { dispatchParse } from "../../src/services/parse-dispatch.service";
import { all, first } from "../../src/repositories/db";
import { makeEnv, PDF_BYTES, seedDocument, type TestEnv } from "../helpers";

const HTML = readFileSync(join(import.meta.dirname, "../../../../tests/fixtures/source/consolidated-cause-list.trimmed.html"), "utf8");
const PAGE = "https://ghconline.gov.in/index.php/consolidated-cause-list/";

function mockFetch(routes: Record<string, () => Response>, log: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    log.push(`${init?.method ?? "GET"} ${url} ${JSON.stringify(init?.headers ?? {})}`);
    const r = routes[url];
    if (!r) return new Response("not found", { status: 404 });
    return r();
  }) as typeof fetch;
}
const pdfResponse = (tag: string, headers: Record<string, string> = {}) => new Response(PDF_BYTES(tag), { status: 200, headers: { "content-type": "application/pdf", etag: `"${tag}"`, ...headers } });
const fetcherFor = (t: TestEnv, f: typeof fetch) => new PoliteFetcher({ ...sourceConfigFrom(t.cfg), minimumRequestIntervalMs: 0 }, { fetch: f, sleep: async () => undefined });

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-02T08:00:00Z")); });
afterEach(() => vi.useRealTimers());

describe("crawl", () => {
  it("discovers documents, queues recent ones, and is idempotent on re-crawl", async () => {
    const t = makeEnv();
    const f = fetcherFor(t, mockFetch({ [PAGE]: () => new Response(HTML, { status: 200, headers: { "content-type": "text/html" } }) }));
    const s1 = await runCrawl(t.env, t.cfg, { trigger: "manual", fetcher: f, queue: t.queue as never });
    expect(s1.discovered).toBeGreaterThan(30);
    expect(s1.newDocuments).toBe(s1.discovered);
    expect(s1.queued).toBeGreaterThan(0);
    // only documents inside the lookback window (14 days) or rolling lists are queued
    const queuedIds = new Set(t.queue.sent.map((m) => (m as { documentId: string }).documentId));
    const queuedDocs = await all<{ listing_date: string | null; category_normalized: string }>(t.env.DB, `SELECT listing_date, category_normalized FROM cause_list_documents WHERE id IN (${[...queuedIds].map(() => "?").join(",")})`, ...queuedIds);
    expect(queuedDocs.every((d) => d.category_normalized === "REGULAR_HEARING" || (d.listing_date ?? "") >= "2026-10-19")).toBe(true);

    const before = (await first<{ n: number }>(t.env.DB, "SELECT COUNT(*) AS n FROM cause_list_documents"))!.n;
    t.queue.sent.length = 0;
    const s2 = await runCrawl(t.env, t.cfg, { trigger: "cron", fetcher: f, queue: t.queue as never });
    expect(s2.newDocuments).toBe(0);
    expect((await first<{ n: number }>(t.env.DB, "SELECT COUNT(*) AS n FROM cause_list_documents"))!.n).toBe(before);
    const runs = await all<{ status: string; trigger: string }>(t.env.DB, "SELECT status, trigger FROM crawl_runs ORDER BY started_at");
    expect(runs.map((r) => r.status)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
    expect((await first<{ last_successful_at: string }>(t.env.DB, "SELECT last_successful_at FROM sources"))!.last_successful_at).toBeTruthy();
  });

  it("fails loudly (not 'no lists today') when the layout changes", async () => {
    const t = makeEnv();
    const f = fetcherFor(t, mockFetch({ [PAGE]: () => new Response("<html><body>redesigned</body></html>") }));
    await expect(runCrawl(t.env, t.cfg, { trigger: "manual", fetcher: f, queue: t.queue as never })).rejects.toThrow(/layout may have changed/);
    expect((await first<{ status: string }>(t.env.DB, "SELECT status FROM crawl_runs"))!.status).toBe("FAILED");
    expect((await first<{ last_successful_at: string | null }>(t.env.DB, "SELECT last_successful_at FROM sources"))!.last_successful_at).toBeNull();
  });
});

describe("download + versioning", () => {
  const URL1 = "https://ghconline.gov.in/NewCList/dl-03-11-2026.pdf";
  async function discover(t: TestEnv) {
    const f = fetcherFor(t, mockFetch({ [PAGE]: () => new Response(HTML) }));
    await runCrawl(t.env, t.cfg, { trigger: "manual", fetcher: f, queue: t.queue as never });
    return (await first<{ id: string }>(t.env.DB, "SELECT id FROM cause_list_documents WHERE source_url = ?", URL1))!.id;
  }

  it("stores the PDF unchanged, then no duplicate version for identical bytes", async () => {
    const t = makeEnv();
    const id = await discover(t);
    t.queue.sent.length = 0;
    const log: string[] = [];
    const f1 = fetcherFor(t, mockFetch({ [URL1]: () => pdfResponse("A") }, log));
    const r1 = await downloadAndStore(t.env, t.cfg, id, { fetcher: f1, queue: t.queue });
    expect(r1.kind).toBe("NEW_VERSION");
    const v = (await first<{ r2_key: string; sha256: string; file_size_bytes: number; etag: string }>(t.env.DB, "SELECT * FROM document_versions"))!;
    expect(new TextDecoder().decode(t.r2.store.get(v.r2_key))).toBe(new TextDecoder().decode(PDF_BYTES("A")));
    expect(v.etag).toBe('"A"');
    expect(t.queue.sent).toEqual([expect.objectContaining({ type: "PARSE_DOCUMENT_VERSION" })]);

    const r2 = await downloadAndStore(t.env, t.cfg, id, { fetcher: fetcherFor(t, mockFetch({ [URL1]: () => pdfResponse("A") })), queue: t.queue }, true);
    expect(r2.kind).toBe("UNCHANGED_HASH");
    expect((await first<{ n: number }>(t.env.DB, "SELECT COUNT(*) AS n FROM document_versions"))!.n).toBe(1);
    expect(t.queue.sent).toHaveLength(1);
  });

  it("creates a new immutable version when the hash changes and keeps the old object", async () => {
    const t = makeEnv();
    const id = await discover(t);
    await downloadAndStore(t.env, t.cfg, id, { fetcher: fetcherFor(t, mockFetch({ [URL1]: () => pdfResponse("A") })), queue: t.queue });
    const r = await downloadAndStore(t.env, t.cfg, id, { fetcher: fetcherFor(t, mockFetch({ [URL1]: () => pdfResponse("B") })), queue: t.queue });
    expect(r).toMatchObject({ kind: "NEW_VERSION", versionNumber: 2 });
    const vs = await all<{ version_number: number; r2_key: string }>(t.env.DB, "SELECT version_number, r2_key FROM document_versions ORDER BY version_number");
    expect(vs).toHaveLength(2);
    expect(vs[0]!.r2_key).not.toBe(vs[1]!.r2_key);
    expect(t.r2.store.size).toBe(2); // the old PDF is preserved
    const doc = (await first<{ current_version_id: string }>(t.env.DB, "SELECT current_version_id FROM cause_list_documents WHERE id = ?", id))!;
    expect(doc.current_version_id).toBe((await first<{ id: string }>(t.env.DB, "SELECT id FROM document_versions WHERE version_number = 2"))!.id);
  });

  it("uses conditional requests and treats 304 as unchanged", async () => {
    const t = makeEnv();
    const id = await discover(t);
    await downloadAndStore(t.env, t.cfg, id, { fetcher: fetcherFor(t, mockFetch({ [URL1]: () => pdfResponse("A") })), queue: t.queue });
    const log: string[] = [];
    const r = await downloadAndStore(t.env, t.cfg, id, { fetcher: fetcherFor(t, mockFetch({ [URL1]: () => new Response(null, { status: 304 }) }, log)), queue: t.queue });
    expect(r.kind).toBe("NOT_MODIFIED");
    expect(log[0]).toContain('"If-None-Match":"\\"A\\""');
  });

  it("rejects files without a PDF signature and does not store them", async () => {
    const t = makeEnv();
    const id = await discover(t);
    const f = fetcherFor(t, mockFetch({ [URL1]: () => new Response("<html>captcha</html>", { status: 200, headers: { "content-type": "application/pdf" } }) }));
    await expect(downloadAndStore(t.env, t.cfg, id, { fetcher: f, queue: t.queue })).rejects.toThrow(/PDF signature/);
    expect(t.r2.store.size).toBe(0);
    expect((await first<{ status: string }>(t.env.DB, "SELECT status FROM cause_list_documents WHERE id = ?", id))!.status).toBe("DOWNLOAD_FAILED");
  });

  it("enforces the byte cap and the host allowlist on redirects", async () => {
    const t = makeEnv({ CRAWLER_MAX_DOWNLOAD_BYTES: "1024" });
    const id = await discover(t);
    const big = fetcherFor(t, mockFetch({ [URL1]: () => new Response(new Uint8Array(5000).fill(37), { status: 200, headers: { "content-length": "5000" } }) }));
    await expect(downloadAndStore(t.env, t.cfg, id, { fetcher: big, queue: t.queue })).rejects.toThrow(/limit/);
    const redirect = fetcherFor(t, mockFetch({ [URL1]: () => new Response(null, { status: 302, headers: { location: "https://evil.example/x.pdf" } }) }));
    await expect(downloadAndStore(t.env, t.cfg, id, { fetcher: redirect, queue: t.queue })).rejects.toThrow(/allowlist/);
  });

  it("marks a vanished file without losing an earlier version", async () => {
    const t = makeEnv();
    const id = await discover(t);
    await downloadAndStore(t.env, t.cfg, id, { fetcher: fetcherFor(t, mockFetch({ [URL1]: () => pdfResponse("A") })), queue: t.queue });
    const r = await downloadAndStore(t.env, t.cfg, id, { fetcher: fetcherFor(t, mockFetch({})), queue: t.queue }, true);
    expect(r.kind).toBe("GONE");
    expect((await first<{ status: string }>(t.env.DB, "SELECT status FROM cause_list_documents WHERE id = ?", id))!.status).toBe("DOWNLOADED");
  });

  it("retries transient failures with backoff but not policy errors", async () => {
    const t = makeEnv();
    let calls = 0;
    const sleeps: number[] = [];
    const f = new PoliteFetcher({ ...sourceConfigFrom(t.cfg), minimumRequestIntervalMs: 0 }, {
      fetch: (async () => (++calls < 3 ? new Response("busy", { status: 503 }) : new Response("ok", { status: 200 }))) as typeof fetch,
      sleep: async (ms) => { sleeps.push(ms); }, random: () => 0,
    });
    const res = await f.get(URL1);
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
    expect(sleeps.filter((s) => s >= 1000)).toEqual([1000, 2000]);
    await expect(f.get("https://evil.example/x")).rejects.toThrow(/allowlist/);
  });
});

describe("parse-result ingestion", () => {
  it("indexes entries in FTS and removes them (and their people) when a version is re-parsed", async () => {
    const t = makeEnv();
    const { versionId } = await seedDocument(t, { url: "https://ghconline.gov.in/NewCList/dl-03-11-2026.pdf", entries: [
      { idx: 0, caseNo: "WP(C)/100/2026", petitioner: "ALPHA TRADERS", respondent: "THE STATE OF ASSAM", padv: ["MR A ONE"], radv: ["GA, ASSAM"], court: "COURT NO: 1" },
      { idx: 1, caseNo: "WA/7/2025", petitioner: "BETA DAS", respondent: "UNION OF INDIA", court: "COURT NO: 1" },
    ] });
    const n = async (sql: string) => (await first<{ n: number }>(t.env.DB, sql))!.n;
    expect(await n("SELECT COUNT(*) AS n FROM cause_list_fts")).toBe(2);
    expect(await n("SELECT COUNT(*) AS n FROM cause_list_fts WHERE cause_list_fts MATCH 'parties:alpha'")).toBe(1);
    expect(await n("SELECT COUNT(*) AS n FROM case_parties")).toBe(4);
    await applyParseResult(t.env, t.cfg, versionId, { phase: "begin", parser_version: "test-2", page_count: 1 });
    expect(await n("SELECT COUNT(*) AS n FROM cause_list_fts")).toBe(0);
    expect(await n("SELECT COUNT(*) AS n FROM cause_list_entries")).toBe(0);
    expect(await n("SELECT COUNT(*) AS n FROM case_parties")).toBe(0);
    expect(await n("SELECT COUNT(*) AS n FROM case_advocates")).toBe(0);
  });

  it("is idempotent when a chunk is re-delivered", async () => {
    const t = makeEnv();
    const { versionId } = await seedDocument(t, { url: "https://ghconline.gov.in/NewCList/dl-04-11-2026.pdf", entries: [{ idx: 0, caseNo: "WP(C)/1/2026", petitioner: "X", respondent: "Y", court: "COURT NO: 2" }] });
    const { entryPayload } = await import("../helpers");
    const chunk = { phase: "chunk" as const, parser_version: "test-1", pages: [], entries: [entryPayload({ idx: 0, caseNo: "WP(C)/1/2026", petitioner: "X", respondent: "Y", court: "COURT NO: 2" })] };
    await applyParseResult(t.env, t.cfg, versionId, chunk);
    await applyParseResult(t.env, t.cfg, versionId, chunk);
    expect((await first<{ n: number }>(t.env.DB, "SELECT COUNT(*) AS n FROM cause_list_entries"))!.n).toBe(1);
    expect((await first<{ n: number }>(t.env.DB, "SELECT COUNT(*) AS n FROM cause_list_fts"))!.n).toBe(1);
    expect((await first<{ n: number }>(t.env.DB, "SELECT COUNT(*) AS n FROM case_parties"))!.n).toBe(2);
  });

  it("recomputes normalization server-side and flags unparseable case numbers instead of inventing them", async () => {
    const t = makeEnv();
    await seedDocument(t, { url: "https://ghconline.gov.in/NewCList/dl-05-11-2026.pdf", entries: [
      { idx: 0, caseNo: "wp(c) 0005 / 2026" }, { idx: 1, caseNo: "SOMETHING ODD" }, { idx: 2, caseNo: null, validation: "UNPARSED" },
    ] });
    const rows = await all<{ case_number_normalized: string | null; validation_status: string; validation_flags_json: string }>(t.env.DB, "SELECT case_number_normalized, validation_status, validation_flags_json FROM cause_list_entries ORDER BY entry_index");
    expect(rows[0]).toMatchObject({ case_number_normalized: "WP(C)/5/2026", validation_status: "VALIDATED" });
    expect(rows[1]).toMatchObject({ case_number_normalized: null, validation_status: "NEEDS_REVIEW" });
    expect(rows[1]!.validation_flags_json).toContain("CASE_NUMBER_UNNORMALIZED");
    expect(rows[2]!.validation_status).toBe("UNPARSED");
  });

  it("rejects invalid page ranges, oversized page counts and malformed payloads", async () => {
    const t = makeEnv({ MAX_PDF_PAGES: "10" });
    const { versionId } = await seedDocument(t, { url: "https://ghconline.gov.in/NewCList/dl-06-11-2026.pdf", entries: [{ idx: 0, caseNo: "WA/1/2026" }] });
    await expect(applyParseResult(t.env, t.cfg, versionId, { phase: "begin", parser_version: "x", page_count: 11 })).rejects.toThrow(/limit/);
    await expect(applyParseResult(t.env, t.cfg, versionId, { phase: "nonsense" })).rejects.toThrow(/Invalid parse payload/);
    const { entryPayload } = await import("../helpers");
    await expect(applyParseResult(t.env, t.cfg, versionId, { phase: "chunk", parser_version: "x", pages: [], entries: [entryPayload({ idx: 5, caseNo: "WA/2/2026", page: 9 })] })).rejects.toThrow(/page range/);
  });

  it("never reports a clean extraction that produced no entries", async () => {
    const t = makeEnv();
    const { versionId } = await seedDocument(t, { url: "https://ghconline.gov.in/NewCList/dl-07-11-2026.pdf", entries: [] });
    const r = await first<{ extraction_status: string }>(t.env.DB, "SELECT extraction_status FROM document_versions WHERE id = ?", versionId);
    expect(r!.extraction_status).toBe("REVIEW_REQUIRED");
  });
});

describe("parser dispatch and queue", () => {
  it("leaves the version PENDING_PARSE when no parser service is configured", async () => {
    const t = makeEnv();
    const { versionId } = await seedDocument(t, { url: "https://ghconline.gov.in/NewCList/dl-08-11-2026.pdf", entries: [] });
    expect(await dispatchParse(t.env, t.cfg, versionId)).toBe("NOT_CONFIGURED");
  });

  it("dispatches an authenticated job without leaking storage credentials", async () => {
    const t = makeEnv({ INGESTION_SERVICE_URL: "http://parser.internal:8000", INGESTION_SERVICE_TOKEN: "t".repeat(20), APP_BASE_URL: "https://worker.example" });
    const { versionId } = await seedDocument(t, { url: "https://ghconline.gov.in/NewCList/dl-09-11-2026.pdf", entries: [] });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response("{}", { status: 202 }); }) as unknown as typeof fetch;
    expect(await dispatchParse(t.env, t.cfg, versionId, f)).toBe("DISPATCHED");
    expect(calls[0]!.url).toBe("http://parser.internal:8000/jobs/parse");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ document_version_id: versionId, parse_entries: true, pdf_url: `https://worker.example/internal/versions/${versionId}/pdf`, callback_url: `https://worker.example/internal/versions/${versionId}/parse-result` });
    expect(JSON.stringify(body)).not.toMatch(/token|secret/i);
  });

  it("retries quickly when the single-job parser reports busy", async () => {
    const t = makeEnv({ INGESTION_SERVICE_URL: "http://parser.internal:8000", INGESTION_SERVICE_TOKEN: "t".repeat(20) });
    const { versionId } = await seedDocument(t, { url: "https://ghconline.gov.in/NewCList/dl-14-11-2026.pdf", entries: [] });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("busy", { status: 503 })) as typeof fetch;
    try {
      const retried: Array<number | undefined> = [];
      await handleQueue({ messages: [{ id: "m", body: { type: "PARSE_DOCUMENT_VERSION", documentVersionId: versionId }, attempts: 4, ack: () => undefined, retry: (o?: { delaySeconds?: number }) => retried.push(o?.delaySeconds) }] } as never, t.env, t.cfg);
      expect(retried).toEqual([20]); // not the 240s exponential backoff
    } finally { globalThis.fetch = realFetch; }
  });

  it("acks poison messages and retries failures with backoff", async () => {
    const t = makeEnv();
    const acked: string[] = []; const retried: Array<{ id: string; delay: number | undefined }> = [];
    const mk = (id: string, body: unknown, attempts = 1) => ({ id, body, attempts, ack: () => acked.push(id), retry: (o?: { delaySeconds?: number }) => retried.push({ id, delay: o?.delaySeconds }) });
    await handleQueue({ messages: [mk("bad", { type: "WHAT" }), mk("missing", { type: "DOWNLOAD_AND_STORE", documentId: "doc_nope" }, 3)] } as never, t.env, t.cfg);
    expect(acked).toEqual(["bad"]);
    expect(retried).toEqual([{ id: "missing", delay: 120 }]);
  });
});

describe("job bookkeeping", () => {
  it("closes the PARSE_DISPATCH job once the parser starts, so 'pending' does not grow forever", async () => {
    const t = makeEnv({ INGESTION_SERVICE_URL: "http://parser.internal:8000", INGESTION_SERVICE_TOKEN: "t".repeat(20) });
    const { versionId } = await seedDocument(t, { url: "https://ghconline.gov.in/NewCList/dl-13-11-2026.pdf", entries: [{ idx: 0, caseNo: "WA/1/2026" }] });
    await dispatchParse(t.env, t.cfg, versionId, (async () => new Response("{}", { status: 202 })) as unknown as typeof fetch);
    const status = async () => (await first<{ status: string }>(t.env.DB, "SELECT status FROM ingestion_jobs WHERE job_type = 'PARSE_DISPATCH'"))!.status;
    expect(await status()).toBe("DISPATCHED");
    await applyParseResult(t.env, t.cfg, versionId, { phase: "begin", parser_version: "x", page_count: 1 });
    expect(await status()).toBe("SUCCEEDED");
  });
});
