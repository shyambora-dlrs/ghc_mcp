import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseResultSchema } from "@ghc/shared-types";
import { applyParseResult } from "../../src/services/ingestion.service";
import { getDocumentPage } from "../../src/services/document.service";
import { searchByAdvocate, searchByParty, searchCase } from "../../src/services/search.service";
import { all, first } from "../../src/repositories/db";
import { createVersion, ensureSource, setCurrentVersion, upsertDiscoveredDocuments } from "../../src/repositories/ingestion.repo";
import { PDF_BYTES, SRC, discovered, makeEnv } from "../helpers";
import { sha256Hex } from "../../src/utils/ids";

/** Python parser -> Worker contract: the exact payloads emitted by ingestion/parser-service (see export_payloads.py). */
const fixtures = JSON.parse(readFileSync(join(import.meta.dirname, "../../../../tests/fixtures/synthetic/parser_payloads.json"), "utf8")) as Record<string, { payloads: Array<Record<string, unknown>>; expected_cases: string[] }>;

async function ingest(name: "layout_a" | "layout_b") {
  const t = makeEnv();
  const src = await ensureSource(t.env.DB, SRC);
  const url = `https://ghconline.gov.in/NewCList/dl-02-11-2026-${name}.pdf`;
  const [o] = await upsertDiscoveredDocuments(t.env.DB, src.id, [discovered({ canonicalUrl: url, listingDate: "2026-11-02" })]);
  const bytes = PDF_BYTES(name);
  const sha = await sha256Hex(bytes);
  const { version } = await createVersion(t.env.DB, { documentId: o!.id, sha256: sha, r2KeyFor: (n) => `k${n}`, store: async () => undefined, contentType: "application/pdf", size: bytes.length, etag: null, lastModified: null, initialStatus: "PENDING_PARSE" });
  await setCurrentVersion(t.env.DB, o!.id, version.id, url);
  const results = [];
  for (const p of fixtures[name]!.payloads) results.push(await applyParseResult(t.env, t.cfg, version.id, p));
  return { t, versionId: version.id, results };
}

describe("parser payloads satisfy the Worker schema", () => {
  for (const name of ["layout_a", "layout_b"] as const) {
    it(`${name}: every payload validates`, () => {
      for (const p of fixtures[name]!.payloads) expect(parseResultSchema.safeParse(p).success, JSON.stringify(parseResultSchema.safeParse(p).error?.issues[0])).toBe(true);
    });
  }
});

describe("Python parser output ingested by the Worker (layout A)", () => {
  it("stores pages, entries, bench context and extraction status", async () => {
    const { t, versionId, results } = await ingest("layout_a");
    expect(results.at(-1)).toMatchObject({ phase: "complete", extraction_status: "EXTRACTED", entries: 7, pages: 2 });
    const v = await first<{ extraction_status: string; parser_version: string; page_count: number }>(t.env.DB, "SELECT extraction_status, parser_version, page_count FROM document_versions WHERE id = ?", versionId);
    expect(v).toMatchObject({ extraction_status: "EXTRACTED", parser_version: "ghc-layout-1.0", page_count: 2 });
    const benches = await all<{ court_label_raw: string; bench_label_raw: string; court_number_normalized: string }>(t.env.DB, "SELECT court_label_raw, bench_label_raw, court_number_normalized FROM court_benches ORDER BY court_label_raw");
    expect(benches).toEqual([
      { court_label_raw: "COURT NO: 1", bench_label_raw: "DIVISION BENCH-I", court_number_normalized: "1" },
      { court_label_raw: "COURT NO: 2", bench_label_raw: "CIVIL BENCH-I", court_number_normalized: "2" },
    ]);
    expect((await getDocumentPage(t.env.DB, versionId, 2)).text_content).toContain("WP(C)/103/2026");
  });
  it("makes parsed entries searchable by case number, party and advocate with page references", async () => {
    const { t } = await ingest("layout_a");
    const c = await searchCase(t.env.DB, { case_number: "wa 77 / 2024" });
    expect(c.page.items).toHaveLength(1);
    expect(c.page.items[0]).toMatchObject({ case_number_normalized: "WA/77/2024", serial_number: "3", page_start: 1, court_label_raw: "COURT NO: 1", section_heading_raw: "- FOR ORDERS -", connected_cases: ["I.A.(CIVIL)/9/2026", "WP(C)/102/2026"] });
    expect(c.page.items[0]!.parties.map((p) => p.name_raw)).toEqual(["DELTA ENTERPRISES AND ORS", "EPSILON DEPT"]);
    expect((await searchByParty(t.env.DB, { party_name: "alpha traders" })).page.items[0]!.case_number_normalized).toBe("WP(C)/101/2026");
    const adv = await searchByAdvocate(t.env.DB, { advocate_name: "mr c three", side: "PETITIONER" });
    expect(adv.page.items[0]).toMatchObject({ case_number_normalized: "CRL.A./55/2025", page_start: 1 });
    expect((await searchCase(t.env.DB, { case_number: "WP(C)/103/2026" })).page.items[0]!.page_start).toBe(2);
  });
  it("is idempotent when the whole payload sequence is delivered twice", async () => {
    const { t, versionId } = await ingest("layout_a");
    for (const p of fixtures.layout_a!.payloads) await applyParseResult(t.env, t.cfg, versionId, p);
    expect((await first<{ n: number }>(t.env.DB, "SELECT COUNT(*) AS n FROM cause_list_entries"))!.n).toBe(7);
    expect((await first<{ n: number }>(t.env.DB, "SELECT COUNT(*) AS n FROM cause_list_fts"))!.n).toBe(7);
    expect((await first<{ n: number }>(t.env.DB, "SELECT COUNT(*) AS n FROM document_pages"))!.n).toBe(2);
  });
});

describe("Python parser output ingested by the Worker (layout B)", () => {
  it("keeps bracketed notes in the bench record and the WITH link", async () => {
    const { t } = await ingest("layout_b");
    const e = (await searchCase(t.env.DB, { case_number: "WP(C)/502/2024" })).page.items[0]!;
    expect(e).toMatchObject({ court_label_raw: "COURT NO: 9", bench_label_raw: null, connected_cases: ["WP(C)/501/2024"], section_heading_raw: "JUDGEMENT" });
    const b = await first<{ judges_json: string }>(t.env.DB, "SELECT judges_json FROM court_benches");
    expect(JSON.parse(b!.judges_json).notes[0]).toMatch(/SYNTHETIC BENCH/);
  });
});
