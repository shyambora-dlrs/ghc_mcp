import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { signDownload, verifyDownload } from "../../src/utils/signing";
import { first } from "../../src/repositories/db";
import { PDF_BYTES, makeEnv, seedDocument } from "../helpers";

const ADMIN = "admin-token-0123456789abcdef";
const PARSER = "parser-token-0123456789abcdef";
const SECRET = "download-secret-0123456789abcdef";
const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const mk = () => makeEnv({ ADMIN_API_TOKEN: ADMIN, PARSER_CALLBACK_TOKEN: PARSER, DOWNLOAD_SIGNING_SECRET: SECRET, MAX_PDF_PAGES: "50" });
const req = (path: string, init: RequestInit & { token?: string } = {}) =>
  new Request(`http://w.test${path}`, { ...init, headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.headers ?? {}) } });

describe("health", () => {
  it("liveness and readiness without secrets", async () => {
    const t = mk();
    expect(await (await worker.fetch(req("/health"), t.env, ctx)).json()).toEqual({ status: "ok", service: "ghc-cause-list-mcp" });
    const ready = await worker.fetch(req("/health/ready"), t.env, ctx);
    expect(ready.status).toBe(200);
    const body = await ready.json() as { checks: Record<string, boolean> };
    expect(body.checks).toEqual({ database: true, storage: true, queue: true });
    expect(JSON.stringify(body)).not.toContain(ADMIN);
  });
  it("reports degraded when the database is down and unknown routes 404", async () => {
    const t = mk();
    t.env.DB = { prepare: () => { throw new Error("db down"); } } as unknown as D1Database;
    const r = await worker.fetch(req("/health/ready"), t.env, ctx);
    expect(r.status).toBe(503);
    expect((await worker.fetch(req("/nope"), mk().env, ctx)).status).toBe(404);
  });
});

describe("admin API", () => {
  it("requires the admin token; the parser and MCP tokens do not work", async () => {
    const t = mk();
    for (const tok of [undefined, "wrong", PARSER]) expect((await worker.fetch(req("/admin/ingestion/status", { token: tok }), t.env, ctx)).status, String(tok)).toBe(401);
    expect((await worker.fetch(req("/admin/ingestion/status", { token: ADMIN }), t.env, ctx)).status).toBe(200);
  });
  it("is disabled entirely when no (or a weak) admin token is configured", async () => {
    for (const tok of ["", "short"]) {
      const t = makeEnv({ ADMIN_API_TOKEN: tok });
      expect((await worker.fetch(req("/admin/ingestion/status", { token: tok || "x" }), t.env, ctx)).status).toBe(401);
    }
  });
  it("lists documents/jobs and retries a document through the queue, with an audit record", async () => {
    const t = mk();
    const d = await seedDocument(t, { url: "https://ghconline.gov.in/NewCList/dl-03-11-2026.pdf", entries: [{ idx: 0, caseNo: "WP(C)/1/2026" }] });
    const docs = await (await worker.fetch(req("/admin/documents?date=2026-11-03", { token: ADMIN }), t.env, ctx)).json() as { items: unknown[] };
    expect(docs.items).toHaveLength(1);
    await t.db.sqlite.exec("UPDATE document_versions SET extraction_status = 'FAILED'");
    const r = await worker.fetch(req(`/admin/ingestion/documents/${d.documentId}/retry`, { method: "POST", token: ADMIN }), t.env, ctx);
    expect(r.status).toBe(202);
    expect(t.queue.sent).toEqual([{ type: "RETRY_DOCUMENT", documentVersionId: d.versionId, reason: "admin retry" }]);
    expect((await first<{ n: number }>(t.env.DB, "SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'document.retry'"))!.n).toBe(1);
    expect((await worker.fetch(req("/admin/ingestion/documents/doc_nope/retry", { method: "POST", token: ADMIN }), t.env, ctx)).status).toBe(404);
    const jobs = await (await worker.fetch(req("/admin/jobs?status=SUCCEEDED", { token: ADMIN }), t.env, ctx)).json() as { jobs: Array<{ id: string }> };
    const one = await (await worker.fetch(req(`/admin/jobs/${jobs.jobs[0]!.id}`, { token: ADMIN }), t.env, ctx)).json() as { job: { id: string } };
    expect(one.job.id).toBe(jobs.jobs[0]!.id);
  });
  it("validates crawl parameters", async () => {
    const t = mk();
    const r = await worker.fetch(req("/admin/ingestion/crawl", { method: "POST", token: ADMIN, body: JSON.stringify({ lookback_days: -5 }) }), t.env, ctx);
    expect(r.status).toBe(400);
  });
});

describe("internal parser routes", () => {
  it("require the parser token, which is distinct from the admin token", async () => {
    const t = mk();
    for (const tok of [undefined, ADMIN]) expect((await worker.fetch(req("/internal/pending-parse", { token: tok }), t.env, ctx)).status).toBe(401);
    expect((await worker.fetch(req("/internal/pending-parse", { token: PARSER }), t.env, ctx)).status).toBe(200);
  });
  it("streams the stored PDF unchanged with its hash", async () => {
    const t = mk();
    const d = await seedDocument(t, { url: "https://ghconline.gov.in/NewCList/dl-03-11-2026.pdf", entries: [{ idx: 0, caseNo: "WP(C)/1/2026" }] });
    const r = await worker.fetch(req(`/internal/versions/${d.versionId}/pdf`, { token: PARSER }), t.env, ctx);
    expect(r.status).toBe(200);
    expect(new TextDecoder().decode(await r.arrayBuffer())).toContain("%PDF-1.7");
    expect(r.headers.get("x-content-sha256")).toMatch(/^[0-9a-f]{64}$/);
    expect((await worker.fetch(req("/internal/versions/ver_missing/pdf", { token: PARSER }), t.env, ctx)).status).toBe(404);
  });
  it("accepts parse results, rejecting bad JSON, invalid payloads and oversized bodies", async () => {
    const t = mk();
    const d = await seedDocument(t, { url: "https://ghconline.gov.in/NewCList/dl-03-11-2026.pdf", entries: [{ idx: 0, caseNo: "WP(C)/1/2026" }] });
    const post = (body: string, headers: Record<string, string> = {}) => worker.fetch(req(`/internal/versions/${d.versionId}/parse-result`, { method: "POST", token: PARSER, body, headers }), t.env, ctx);
    expect((await post(JSON.stringify({ phase: "begin", parser_version: "x", page_count: 1 }))).status).toBe(200);
    expect((await post("{not json")).status).toBe(400);
    expect((await post(JSON.stringify({ phase: "begin", parser_version: "x", page_count: 51 }))).status).toBe(413);
    expect((await post(JSON.stringify({ phase: "wat" }))).status).toBe(400);
    expect((await post("{}", { "content-length": "99999999" })).status).toBe(413);
  });
});

describe("signed downloads", () => {
  it("serves the PDF only for a valid, unexpired signature bound to the version", async () => {
    const t = mk();
    const d = await seedDocument(t, { url: "https://ghconline.gov.in/NewCList/dl-03-11-2026.pdf", entries: [{ idx: 0, caseNo: "WP(C)/1/2026" }] });
    const s = await signDownload(SECRET, d.versionId, 60);
    const ok = await worker.fetch(req(s.path), t.env, ctx);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/pdf");
    expect((await worker.fetch(req(s.path.replace(/sig=./, "sig=0")), t.env, ctx)).status).toBe(403);
    expect((await worker.fetch(req(`/download/other_version?exp=${s.exp}&sig=${s.sig}`), t.env, ctx)).status).toBe(403);
    expect((await worker.fetch(req(`/download/${d.versionId}`), t.env, ctx)).status).toBe(403);
    const expired = await signDownload(SECRET, d.versionId, 60, Date.now() - 3_600_000);
    expect(await verifyDownload(SECRET, d.versionId, String(expired.exp), expired.sig)).toBe(false);
    expect(await verifyDownload("", d.versionId, String(s.exp), s.sig)).toBe(false);
  });
});

describe("push-mode runner routes", () => {
  const FIXTURE = readFileSync(join(import.meta.dirname, "../../../../tests/fixtures/source/consolidated-cause-list.trimmed.html"), "utf8");
  it("accept a pushed source page and PDFs, running the same validation and versioning as a Worker-side download", async () => {
    const t = mk();
    const r = await worker.fetch(req("/internal/runner/source-page", { method: "POST", token: PARSER, body: JSON.stringify({ html: FIXTURE, final_url: "https://ghconline.gov.in/index.php/consolidated-cause-list/", lookback_days: 3650 }) }), t.env, ctx);
    expect(r.status).toBe(200);
    const { summary } = await r.json() as { summary: { discovered: number; queued: number; toFetch: Array<{ document_id: string; url: string; etag: string | null }> } };
    expect(summary.discovered).toBeGreaterThan(30);
    expect(t.queue.sent).toEqual([]); // nothing is queued for download in push mode
    const item = summary.toFetch.find((x) => x.url.endsWith("dl-03-11-2026.pdf"))!;
    const put = (bytes: Uint8Array, headers: Record<string, string> = {}) => worker.fetch(req(`/internal/runner/documents/${item.document_id}/pdf`, { method: "PUT", token: PARSER, body: bytes as unknown as BodyInit, headers: { "content-type": "application/pdf", "x-source-final-url": item.url, "x-source-etag": '"e1"', ...headers } }), t.env, ctx);
    const ok = await put(PDF_BYTES("one"));
    expect(await ok.json()).toMatchObject({ success: true, outcome: { kind: "NEW_VERSION", versionNumber: 1 } });
    expect(t.queue.sent).toEqual([expect.objectContaining({ type: "PARSE_DOCUMENT_VERSION" })]);
    expect(await (await put(PDF_BYTES("one"))).json()).toMatchObject({ outcome: { kind: "UNCHANGED_HASH" } });
    expect(await (await put(PDF_BYTES("two"))).json()).toMatchObject({ outcome: { kind: "NEW_VERSION", versionNumber: 2 } });
    expect(t.r2.store.size).toBe(2);
    expect((await put(new TextEncoder().encode("<html>captcha</html>"))).status).toBe(415);
    expect((await put(PDF_BYTES("x"), { "x-source-final-url": "https://evil.example/x.pdf" })).status).toBe(403);
  });
  it("require the parser token and a sane payload", async () => {
    const t = mk();
    expect((await worker.fetch(req("/internal/runner/source-page", { method: "POST", body: "{}" }), t.env, ctx)).status).toBe(401);
    expect((await worker.fetch(req("/internal/runner/source-page", { method: "POST", token: ADMIN, body: "{}" }), t.env, ctx)).status).toBe(401);
    expect((await worker.fetch(req("/internal/runner/source-page", { method: "POST", token: PARSER, body: JSON.stringify({ html: "short" }) }), t.env, ctx)).status).toBe(400);
    expect((await worker.fetch(req("/internal/runner/source-page", { method: "POST", token: PARSER, body: JSON.stringify({ html: "<html>".padEnd(200, "x"), final_url: "https://evil.example/" }) }), t.env, ctx)).status).toBe(403);
  });
});
