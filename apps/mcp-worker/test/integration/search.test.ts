import { beforeAll, describe, expect, it } from "vitest";
import { compareVersions } from "../../src/services/compare.service";
import { getDocumentDetails, getDocumentPage } from "../../src/services/document.service";
import {
  availableDates, casesByDate, getEntryDetails, listDocuments, searchByAdvocate, searchByBench, searchByCourt, searchByParty, searchCase,
} from "../../src/services/search.service";
import { getIngestionStatus } from "../../src/services/status.service";
import { all, first } from "../../src/repositories/db";
import { makeEnv, seedDocument, type SeedEntry, type TestEnv } from "../helpers";

const DB = (t: TestEnv) => t.env.DB;
let t: TestEnv;
let d1: { documentId: string; versionId: string };
let d1v1: { documentId: string; versionId: string };
let d2: { documentId: string; versionId: string };

const C3 = { court: "COURT NO: 3", bench: "[DIVISION BENCH-I]", judges: ["HONOURABLE MR. JUSTICE ABC XYZ"] };
const C5 = { court: "COURT NO: 5", bench: "[CRIMINAL BENCH]", judges: ["HONOURABLE MR. JUSTICE PQR LMN"] };
const V1: SeedEntry[] = [
  { idx: 0, serial: "1", caseNo: "WP(C)/1234/2026", petitioner: "RAMESH KUMAR SHARMA", respondent: "THE STATE OF ASSAM", padv: ["MR D K DAS", "MR A ONE"], radv: ["GA, ASSAM"], heading: "- FOR ORDERS -", page: 1, ...C3 },
  { idx: 1, serial: "2", caseNo: "WP(C)/55/2026", petitioner: "ALPHA TRADERS", respondent: "UNION OF INDIA", padv: ["MR B TWO"], radv: ["SC, CGC"], page: 1, ...C3 },
  { idx: 2, serial: "4", caseNo: "I.A.(Civil)/2645/2025", petitioner: "SMT RINA DEVI", respondent: "THE STATE OF ASSAM", padv: ["MR D K DAS"], page: 2, ...C3, validation: "NEEDS_REVIEW" },
  { idx: 3, serial: "1", caseNo: "Crl.A./91/2017", petitioner: "SRI BHASKAR NATH", respondent: "THE STATE OF ASSAM", padv: ["MR C THREE"], radv: ["PP, ASSAM"], page: 3, ...C5 },
  { idx: 4, serial: "2", caseNo: "WA/1234/2026", petitioner: "GAMMA LTD", respondent: "DELTA CORP", page: 3, ...C5 },
];

beforeAll(async () => {
  t = makeEnv();
  d1v1 = await seedDocument(t, { url: "https://ghconline.gov.in/NewCList/dl-03-11-2026.pdf", date: "2026-11-03", label: "Daily", entries: V1, bytesTag: "v1" });
  // second version of the same document (corrected PDF): drops WA/1234, changes serial + advocate, adds a new case
  const V2: SeedEntry[] = [
    { ...V1[0]!, serial: "3" },
    { ...V1[1]!, padv: ["MR B TWO", "MR NEW ADVOCATE"] },
    V1[2]!, V1[3]!,
    { idx: 4, serial: "5", caseNo: "WP(C)/777/2026", petitioner: "NEW PARTY", respondent: "OTHERS", page: 3, ...C5 },
  ];
  d1 = await seedDocument(t, { url: "https://ghconline.gov.in/NewCList/dl-03-11-2026.pdf", date: "2026-11-03", label: "Daily", entries: V2, bytesTag: "v2" });
  d2 = await seedDocument(t, { url: "https://ghconline.gov.in/NewCList/sl-03-11-2026.pdf", date: "2026-11-03", category: "SUPPLEMENTARY", label: "Supplementary", entries: [
    { idx: 0, serial: "7", caseNo: "WP(C)/1234/2026", petitioner: "RAMESH KUMAR SHARMA", respondent: "THE STATE OF ASSAM", court: "COURT NO: 3", bench: "[DIVISION BENCH-I]", page: 1 },
  ] });
  await seedDocument(t, { url: "https://ghconline.gov.in/NewCList/dl-02-11-2026.pdf", date: "2026-11-02", label: "Daily", entries: [{ idx: 0, serial: "1", caseNo: "WP(C)/9/2026", petitioner: "OLDER", respondent: "LIST", court: "COURT NO: 3" }] });
  await seedDocument(t, { url: "https://ghconline.gov.in/NewCList/no-02-11-2026.pdf", date: "2026-11-02", category: "NOTICE", label: "Notices", entries: [] });
});

describe("search_case", () => {
  it("returns exact matches first, from current versions only", async () => {
    const r = await searchCase(DB(t), { case_number: "WP(C)/1234/2026" });
    expect(r.page.total).toBe(2); // daily (v2) + supplementary
    expect(r.page.items.every((i) => i.match_type === "EXACT")).toBe(true);
    expect(new Set(r.page.items.map((i) => i.source.document_id))).toEqual(new Set([d1.documentId, d2.documentId]));
    expect(r.page.items.every((i) => i.source.is_current_version)).toBe(true);
    const daily = r.page.items.find((i) => i.source.document_id === d1.documentId)!;
    expect(daily).toMatchObject({ serial_number: "3", court_label_raw: "COURT NO: 3", bench_label_raw: "[DIVISION BENCH-I]", page_start: 1, listing_date: "2026-11-03", category_label_raw: "Daily" });
    expect(daily.parties.map((p) => p.name_raw)).toEqual(["RAMESH KUMAR SHARMA", "THE STATE OF ASSAM"]);
    expect(daily.advocates.filter((a) => a.side === "PETITIONER").map((a) => a.name_raw)).toEqual(["MR D K DAS", "MR A ONE"]);
    expect(daily.source.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("normalizes user input variants (spacing, case, leading zeros)", async () => {
    for (const q of ["wp(c) 1234 / 2026", "WP(C)/01234/2026", " wp(c)/1234/2026 "]) {
      expect((await searchCase(DB(t), { case_number: q })).page.total, q).toBe(2);
    }
  });
  it("filters by date and can include previous versions", async () => {
    // WA/1234/2026 exists only in the superseded v1: no EXACT hit among current versions (only labelled PARTIAL fallbacks).
    const cur = await searchCase(DB(t), { case_number: "WA/1234/2026" });
    expect(cur.page.items.every((i) => i.match_type === "PARTIAL")).toBe(true);
    const prev = await searchCase(DB(t), { case_number: "WA/1234/2026", include_previous_versions: true });
    expect(prev.page.total).toBe(1);
    expect(prev.page.items[0]!.source).toMatchObject({ version_number: 1, is_current_version: false });
    expect((await searchCase(DB(t), { case_number: "WP(C)/1234/2026", listing_date: "2026-11-02" })).page.total).toBe(0);
  });
  it("labels partial matches and only uses them when there is no exact match", async () => {
    const r = await searchCase(DB(t), { case_number: "WP(Crl)/1234/2026" });
    expect(r.page.items.length).toBeGreaterThan(0);
    expect(r.page.items.every((i) => i.match_type === "PARTIAL")).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/PARTIAL/);
    const full = await searchCase(DB(t), { case_number: "1234/2026" });
    expect(full.page.items.every((i) => i.match_type === "PARTIAL")).toBe(true);
  });
  it("says so honestly when nothing matches", async () => {
    const r = await searchCase(DB(t), { case_number: "WP(C)/99999/2026" });
    expect(r.page.total).toBe(0);
    expect(r.warnings.join(" ")).toMatch(/does not mean/);
  });
  it("treats LIKE wildcards and SQL as data", async () => {
    expect((await searchCase(DB(t), { case_number: "%%%" })).page.total).toBe(0);
    expect((await searchCase(DB(t), { case_number: "'; DROP TABLE cause_list_entries; --" })).page.total).toBe(0);
    expect((await first<{ n: number }>(DB(t), "SELECT COUNT(*) AS n FROM cause_list_entries"))!.n).toBeGreaterThan(0);
  });
});

describe("party and advocate search", () => {
  it("matches phrase before token matches and preserves source spelling", async () => {
    const phrase = await searchByParty(DB(t), { party_name: "ramesh kumar" });
    expect(phrase.page.items[0]!.match_type).toBe("PHRASE");
    const tokens = await searchByParty(DB(t), { party_name: "sharma ramesh" });
    expect(tokens.page.total).toBeGreaterThan(0);
    expect(tokens.page.items[0]!.match_type).toBe("ALL_TOKENS");
    expect(tokens.page.items[0]!.parties[0]!.name_raw).toBe("RAMESH KUMAR SHARMA");
  });
  it("requires all words in one party name and honours side", async () => {
    expect((await searchByParty(DB(t), { party_name: "ramesh assam" })).page.total).toBe(0); // different parties
    expect((await searchByParty(DB(t), { party_name: "state assam", side: "RESPONDENT" })).page.total).toBeGreaterThan(0);
    expect((await searchByParty(DB(t), { party_name: "state assam", side: "PETITIONER" })).page.total).toBe(0);
  });
  it("supports prefix matching and listing_date", async () => {
    expect((await searchByParty(DB(t), { party_name: "alph", listing_date: "2026-11-03" })).page.total).toBe(1);
    expect((await searchByParty(DB(t), { party_name: "alph", listing_date: "2026-11-02" })).page.total).toBe(0);
  });
  it("advocate search by side, never merging similar names", async () => {
    const r = await searchByAdvocate(DB(t), { advocate_name: "d k das" });
    expect(new Set(r.page.items.map((i) => i.case_number_normalized))).toEqual(new Set(["WP(C)/1234/2026", "I.A.(CIVIL)/2645/2025"]));
    expect((await searchByAdvocate(DB(t), { advocate_name: "d k das", side: "RESPONDENT" })).page.total).toBe(0);
    expect((await searchByAdvocate(DB(t), { advocate_name: "ga assam", side: "RESPONDENT" })).page.total).toBeGreaterThan(0);
    expect((await searchByAdvocate(DB(t), { advocate_name: "D K DASS" })).page.total).toBe(0);
    expect((await searchByAdvocate(DB(t), { advocate_name: "d k das" })).warnings.join(" ")).toMatch(/no identities are merged/);
  });
  it("is safe against FTS and SQL syntax in the query", async () => {
    for (const q of ['"; DROP TABLE case_parties; --', "a* OR b", "NEAR(a b)", "parties:x", "x\" y"]) {
      await expect(searchByParty(DB(t), { party_name: q }).then((r) => r.page.total)).resolves.toBeGreaterThanOrEqual(0);
    }
    for (const q of ["(((", "\\"]) await expect(searchByParty(DB(t), { party_name: q })).rejects.toThrow(/letters or digits/);
    expect((await first<{ n: number }>(DB(t), "SELECT COUNT(*) AS n FROM case_parties"))!.n).toBeGreaterThan(0);
    await expect(searchByParty(DB(t), { party_name: "!!!" })).rejects.toThrow(/letters or digits/);
  });
  it("uses only bound parameters: user text never appears in prepared SQL", async () => {
    const marker = "ZZMARKERZZ";
    await searchByParty(DB(t), { party_name: marker });
    await searchByAdvocate(DB(t), { advocate_name: marker });
    await searchCase(DB(t), { case_number: `${marker}/1/2026` });
    await searchByCourt(DB(t), { court_query: marker });
    await searchByBench(DB(t), { bench_query: marker });
    expect((DB(t) as unknown as { statementLog: string[] }).statementLog.some((s) => s.includes(marker))).toBe(false);
  });
});

describe("court, bench and date views", () => {
  it("finds a court by number or label and groups by document and heading", async () => {
    const a = await searchByCourt(DB(t), { court_query: "Court No. 3", listing_date: "2026-11-03" });
    const b = await searchByCourt(DB(t), { court_query: "3", listing_date: "2026-11-03" });
    expect(a.page.total).toBe(b.page.total);
    expect(a.page.total).toBe(4); // 3 in daily v2 + 1 in supplementary
    expect(a.groups!.length).toBe(2);
    expect(a.page.items.every((i) => i.court_label_raw === "COURT NO: 3")).toBe(true);
  });
  it("warns about non-contiguous serial numbers in a court section and unverified entries", async () => {
    const r = await searchByCourt(DB(t), { court_query: "3", listing_date: "2026-11-03", document_id: d1.documentId });
    expect(r.warnings.join(" ")).toMatch(/uncertain extraction/);
    const x = makeEnv();
    await seedDocument(x, { url: "https://ghconline.gov.in/NewCList/dl-11-11-2026.pdf", date: "2026-11-11", entries: [1, 2, 4].map((n, i) => ({ idx: i, serial: String(n), caseNo: `WA/${n}/2026`, court: "COURT NO: 8" })) });
    const gap = await searchByCourt(x.env.DB, { court_query: "8", listing_date: "2026-11-11" });
    expect(gap.warnings.join(" ")).toMatch(/not contiguous.*missing 3/);
  });
  it("searches bench headings and judge names as printed", async () => {
    const r = await searchByBench(DB(t), { bench_query: "justice abc xyz", listing_date: "2026-11-03" });
    expect(r.page.total).toBeGreaterThan(0);
    expect(r.page.items.every((i) => i.judges.includes("HONOURABLE MR. JUSTICE ABC XYZ"))).toBe(true);
    expect((await searchByBench(DB(t), { bench_query: "criminal bench" })).page.items[0]!.court_label_raw).toBe("COURT NO: 5");
    expect((await searchByBench(DB(t), { bench_query: "Chief Justice of India" })).page.total).toBe(0);
  });
  it("keeps several lists on one date distinct, and filters by category (normalized or raw)", async () => {
    const all3 = await casesByDate(DB(t), { listing_date: "2026-11-03" });
    expect(new Set(all3.page.items.map((i) => i.category_label_raw))).toEqual(new Set(["Daily", "Supplementary"]));
    expect((await casesByDate(DB(t), { listing_date: "2026-11-03", category: "SUPPLEMENTARY" })).page.total).toBe(1);
    expect((await casesByDate(DB(t), { listing_date: "2026-11-03", category: "supplementary" })).page.total).toBe(1);
    expect((await casesByDate(DB(t), { listing_date: "2026-11-03", category: "Daily", court_query: "5" })).page.total).toBe(2);
    expect((await casesByDate(DB(t), { listing_date: "2030-01-01" })).warnings.join(" ")).toMatch(/may not be published/);
    await expect(casesByDate(DB(t), { listing_date: "03/11/2026" })).rejects.toThrow(/YYYY-MM-DD/);
  });
  it("paginates with stable cursors and bounded limits", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const r = await casesByDate(DB(t), { listing_date: "2026-11-03", limit: 2, cursor });
      seen.push(...r.page.items.map((x) => x.entry_id));
      cursor = r.page.next_cursor;
      if (!cursor) break;
    }
    expect(seen.length).toBe(6);
    expect(new Set(seen).size).toBe(6);
    await expect(casesByDate(DB(t), { listing_date: "2026-11-03", cursor: "garbage!!" })).rejects.toThrow(/cursor/);
    expect((await casesByDate(DB(t), { listing_date: "2026-11-03", limit: 100000 })).page.limit).toBe(200);
  });
});

describe("entry, document and page retrieval", () => {
  it("returns an entry by id with raw text and provenance, and rejects ambiguous selectors", async () => {
    const found = await searchCase(DB(t), { case_number: "WP(C)/55/2026" });
    const e = await getEntryDetails(DB(t), { entry_id: found.page.items[0]!.entry_id, include_raw_text: true });
    expect(e.raw_text).toContain("WP(C)/55/2026");
    expect(e.source.document_version_id).toBe(d1.versionId);
    const noRaw = await getEntryDetails(DB(t), { entry_id: e.entry_id, include_raw_text: false });
    expect(noRaw.raw_text).toBeUndefined();
    await expect(getEntryDetails(DB(t), { case_number: "WP(C)/1234/2026", listing_date: "2026-11-03" })).rejects.toThrow(/ambiguous/);
    expect((await getEntryDetails(DB(t), { case_number: "WP(C)/1234/2026", document_id: d2.documentId })).serial_number).toBe("7");
    await expect(getEntryDetails(DB(t), { entry_id: "nope" })).rejects.toThrow(/not found/);
    await expect(getEntryDetails(DB(t), {})).rejects.toThrow(/Provide entry_id/);
  });
  it("lists available dates only for downloaded documents, with category counts", async () => {
    const dates = await availableDates(DB(t), { limit: 10 });
    expect(dates.map((d) => d.date)).toEqual(["2026-11-03", "2026-11-02"]);
    expect(dates[0]!.categories.map((c) => c.category_label_raw)).toEqual(["Daily", "Supplementary"]);
    expect((await availableDates(DB(t), { from_date: "2026-11-03" })).length).toBe(1);
    expect((await availableDates(DB(t), { category: "NOTICE" }))[0]!.categories[0]!.category_normalized).toBe("NOTICE");
  });
  it("lists documents including those not yet downloaded, with honest status", async () => {
    const { upsertDiscoveredDocuments, ensureSource } = await import("../../src/repositories/ingestion.repo");
    const { SRC, discovered } = await import("../helpers");
    const src = await ensureSource(DB(t), SRC);
    await upsertDiscoveredDocuments(DB(t), src.id, [discovered({ canonicalUrl: "https://ghconline.gov.in/NewCList/lz-03-11-2026.pdf", listingDate: "2026-11-03", categoryLabelRaw: "Lawazima", categoryNormalized: "LAWAZIMA" })]);
    const docs = await listDocuments(DB(t), { listing_date: "2026-11-03" });
    expect(docs.items.map((d) => d.category_label_raw).sort()).toEqual(["Daily", "Lawazima", "Supplementary"]);
    expect(docs.items.find((d) => d.category_label_raw === "Lawazima")).toMatchObject({ status: "DISCOVERED", extraction_status: null });
  });
  it("returns document details with version history, object availability and a signed link", async () => {
    const { cfg } = makeEnv({ DOWNLOAD_SIGNING_SECRET: "s".repeat(32), APP_BASE_URL: "https://w.example" });
    const d = await getDocumentDetails(t.env, cfg, d1.documentId);
    expect(d.versions.map((v) => v.version_number)).toEqual([2, 1]);
    expect(d.version).toMatchObject({ version_number: 2, is_current: true, r2_object_available: true, entry_count: 5, extraction_status: "EXTRACTED" });
    expect(d.download?.url_path).toMatch(/^https:\/\/w\.example\/download\/.+\?exp=\d+&sig=[0-9a-f]{64}$/);
    const old = await getDocumentDetails(t.env, cfg, d1.documentId, d1v1.versionId);
    expect(old.version).toMatchObject({ version_number: 1, is_current: false });
    expect((await getDocumentDetails(t.env, makeEnv().cfg, d1.documentId)).download).toBeNull();
    await expect(getDocumentDetails(t.env, cfg, d1.documentId, d2.versionId)).rejects.toThrow(/does not belong/);
  });
  it("returns 1-based pages and explains out-of-range requests", async () => {
    const p = await getDocumentPage(DB(t), d1.versionId, 3);
    expect(p).toMatchObject({ page_number: 3, page_status: "OK", extraction_method: "TEXT", document_id: d1.documentId });
    await expect(getDocumentPage(DB(t), d1.versionId, 0)).rejects.toThrow(/between 1 and 3/);
    await expect(getDocumentPage(DB(t), d1.versionId, 99)).rejects.toThrow(/between 1 and 3/);
  });
});

describe("compare_cause_lists", () => {
  it("reports added, removed and changed entries without interpreting them", async () => {
    const c = await compareVersions(DB(t), d1.documentId, d1v1.versionId, d1.versionId);
    expect(c.counts).toMatchObject({ older_entries: 5, newer_entries: 5, added: 1, removed: 1, changed: 2, unchanged: 2, ambiguous: 0 });
    expect(c.added.map((e) => e.case_number)).toEqual(["WP(C)/777/2026"]);
    expect(c.removed.map((e) => e.case_number)).toEqual(["WA/1234/2026"]);
    expect(c.changed.find((x) => x.case_number === "WP(C)/1234/2026")!.changed_fields).toEqual(["serial_number"]);
    expect(c.changed.find((x) => x.case_number === "WP(C)/55/2026")!.changed_fields).toEqual(["advocates"]);
    expect(c.caveats.join(" ")).toMatch(/does NOT mean a matter was disposed/);
  });
  it("rejects versions from different documents or identical ids", async () => {
    await expect(compareVersions(DB(t), d1.documentId, d1v1.versionId, d2.versionId)).rejects.toThrow(/same|belong/);
    await expect(compareVersions(DB(t), d1.documentId, d1.versionId, d1.versionId)).rejects.toThrow(/differ/);
  });
  it("exposes ambiguity instead of guessing when a case number repeats", async () => {
    const x = makeEnv();
    const base: SeedEntry = { idx: 0, caseNo: "WP(C)/5/2026", petitioner: "A", respondent: "B" };
    const url = "https://ghconline.gov.in/NewCList/dl-10-11-2026.pdf";
    const a = await seedDocument(x, { url, date: "2026-11-10", entries: [{ ...base, court: "COURT NO: 1" }, { ...base, idx: 1, court: "COURT NO: 2" }], bytesTag: "a" });
    const b = await seedDocument(x, { url, date: "2026-11-10", entries: [{ ...base, court: "COURT NO: 3" }], bytesTag: "b" });
    const c = await compareVersions(x.env.DB, a.documentId, a.versionId, b.versionId);
    expect(c.counts.ambiguous).toBe(1);
    expect(c.ambiguous[0]!.older).toHaveLength(2);
    expect(c.counts.removed + c.counts.added).toBe(0);
  });
});

describe("ingestion status", () => {
  it("reports counts, freshness and withholds internal error text from public callers", async () => {
    await DB(t).prepare("INSERT INTO ingestion_jobs (id, job_type, status, last_error_code, last_error_message, created_at, updated_at) VALUES ('j1','DOWNLOAD_AND_STORE','FAILED','HTTP_500','internal stack detail',?,?)").bind(new Date().toISOString(), new Date().toISOString()).run();
    const pub = await getIngestionStatus(t.env, t.cfg, { include_errors: true }, false) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(JSON.stringify(pub.recent_errors)).not.toContain("internal stack detail");
    const adm = await getIngestionStatus(t.env, t.cfg, { include_errors: true }, true) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(JSON.stringify(adm.recent_errors)).toContain("internal stack detail");
    expect(pub.data_freshness.warnings.join(" ")).toMatch(/No successful crawl/);
    expect(pub.current_versions_by_extraction_status.EXTRACTED).toBeGreaterThan(0);
    expect(await all(DB(t), "SELECT 1 FROM sources")).toEqual([{ "1": 1 }]);
  });
});

describe("seed script", () => {
  it("loads cleanly and is searchable (synthetic data only)", async () => {
    const x = makeEnv();
    const sql = (await import("node:fs")).readFileSync(new URL("../../../../database/seed/test-seed.sql", import.meta.url), "utf8");
    (x.db as unknown as { sqlite: { exec(s: string): void } }).sqlite.exec(sql);
    (x.db as unknown as { sqlite: { exec(s: string): void } }).sqlite.exec(sql); // idempotent
    expect((await searchCase(x.env.DB, { case_number: "WP(C)/1/2099" })).page.total).toBe(1);
    expect((await searchByParty(x.env.DB, { party_name: "synthetic petitioner" })).page.total).toBe(1);
    expect((await searchByAdvocate(x.env.DB, { advocate_name: "synthetic advocate" })).page.total).toBe(1);
  });
});
