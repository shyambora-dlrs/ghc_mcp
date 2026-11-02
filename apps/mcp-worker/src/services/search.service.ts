import { normalizeCaseNumber, normalizeCourtNumber, normalizeName } from "@ghc/shared-types";
import { IN_CHUNK, all, chunk, first, likeEscape, placeholders } from "../repositories/db";
import { decodeCursor, pageOf, type Page } from "../utils/cursor";
import { invalid, notFound } from "../utils/errors";

/**
 * Deterministic retrieval over D1. Nothing here calls an LLM. Every query uses bound parameters;
 * user text is only ever interpolated as a bound value (LIKE patterns are escaped, FTS expressions
 * are built exclusively from [A-Z0-9] tokens).
 */

export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 20;

export interface PersonResult {
  side: string;
  name_raw: string;
  sequence: number | null;
}

export interface EntryResult {
  entry_id: string;
  case_number_raw: string | null;
  case_number_normalized: string | null;
  case_type: string | null;
  case_year: number | null;
  listing_date: string | null;
  category_label_raw: string | null;
  category_normalized: string | null;
  serial_number: string | null;
  item_number: string | null;
  section_heading_raw: string | null;
  listing_note_raw: string | null;
  connected_cases: string[];
  court_label_raw: string | null;
  bench_label_raw: string | null;
  judges: string[];
  parties: PersonResult[];
  advocates: PersonResult[];
  page_start: number | null;
  page_end: number | null;
  extraction_method: string;
  extraction_confidence: number | null;
  validation_status: string;
  validation_flags: string[];
  match_type?: string;
  source: {
    document_id: string;
    document_version_id: string;
    version_number: number;
    title: string | null;
    source_url: string;
    sha256: string;
    is_current_version: boolean;
  };
}

interface EntryRow {
  id: string;
  document_version_id: string;
  serial_number: string | null;
  item_number: string | null;
  case_number_raw: string | null;
  case_number_normalized: string | null;
  case_type: string | null;
  case_year: number | null;
  listing_date: string | null;
  listing_note_raw: string | null;
  section_heading_raw: string | null;
  connected_cases_json: string | null;
  page_start: number | null;
  page_end: number | null;
  extraction_method: string;
  extraction_confidence: number | null;
  validation_status: string;
  validation_flags_json: string | null;
  raw_text: string;
  court_label_raw: string | null;
  bench_label_raw: string | null;
  judges_json: string | null;
  document_id: string;
  version_number: number;
  sha256: string;
  title: string | null;
  source_url: string;
  category_label_raw: string | null;
  category_normalized: string | null;
  current_version_id: string | null;
  match_type?: string;
}

const SELECT_ENTRY = `
  SELECT e.id, e.document_version_id, e.serial_number, e.item_number, e.case_number_raw, e.case_number_normalized,
         e.case_type, e.case_year, e.listing_date, e.listing_note_raw, e.section_heading_raw, e.connected_cases_json,
         e.page_start, e.page_end, e.extraction_method, e.extraction_confidence, e.validation_status,
         e.validation_flags_json, e.raw_text,
         b.court_label_raw, b.bench_label_raw, b.judges_json,
         v.document_id, v.version_number, v.sha256,
         d.title, d.source_url, d.category_label_raw, d.category_normalized, d.current_version_id`;
const FROM_ENTRY = `
  FROM cause_list_entries e
  JOIN document_versions v ON v.id = e.document_version_id
  JOIN cause_list_documents d ON d.id = v.document_id
  LEFT JOIN court_benches b ON b.id = e.court_bench_id`;

/** Small WHERE-clause builder that keeps SQL text and bound parameters in lockstep. */
export class Where {
  private clauses: string[] = [];
  readonly params: unknown[] = [];
  add(clause: string, ...params: unknown[]): this {
    this.clauses.push(clause);
    this.params.push(...params);
    return this;
  }
  sql(): string {
    return this.clauses.length ? `WHERE ${this.clauses.join(" AND ")}` : "";
  }
}

export interface CommonFilters {
  listing_date?: string | null;
  category?: string | null;
  include_previous_versions?: boolean;
  document_id?: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function applyCommon(w: Where, f: CommonFilters): void {
  if (!f.include_previous_versions) w.add("d.current_version_id = v.id");
  if (f.listing_date) {
    if (!ISO_DATE.test(f.listing_date)) throw invalid("listing_date must be in YYYY-MM-DD format.");
    w.add("e.listing_date = ?", f.listing_date);
  }
  if (f.category) applyCategory(w, f.category);
  if (f.document_id) w.add("d.id = ?", f.document_id);
}

/** Category matches the controlled value (DAILY) or the exact label published by the source ("Daily"). */
export function applyCategory(w: Where, category: string, alias = "d"): void {
  const norm = category.trim().toUpperCase().replace(/[\s-]+/g, "_");
  w.add(`(${alias}.category_normalized = ? OR LOWER(${alias}.category_label_raw) = LOWER(?))`, norm, category.trim());
}

export function clampLimit(limit: number | undefined | null, def = DEFAULT_LIMIT): number {
  if (limit === undefined || limit === null) return def;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

interface PeopleRow {
  cause_list_entry_id: string;
  side: string;
  name_raw: string;
  sequence_number: number | null;
}

async function hydrate(db: D1Database, rows: EntryRow[], includeRaw = false): Promise<EntryResult[]> {
  const ids = rows.map((r) => r.id);
  const parties = new Map<string, PersonResult[]>();
  const advocates = new Map<string, PersonResult[]>();
  for (const part of chunk(ids, IN_CHUNK)) {
    const ph = placeholders(part.length);
    const ps = await all<PeopleRow>(db, `SELECT cause_list_entry_id, side, party_name_raw AS name_raw, sequence_number FROM case_parties WHERE cause_list_entry_id IN (${ph}) ORDER BY sequence_number`, ...part);
    const as = await all<PeopleRow>(db, `SELECT cause_list_entry_id, side, advocate_name_raw AS name_raw, sequence_number FROM case_advocates WHERE cause_list_entry_id IN (${ph}) ORDER BY side, sequence_number`, ...part);
    for (const p of ps) (parties.get(p.cause_list_entry_id) ?? parties.set(p.cause_list_entry_id, []).get(p.cause_list_entry_id)!).push({ side: p.side, name_raw: p.name_raw, sequence: p.sequence_number });
    for (const a of as) (advocates.get(a.cause_list_entry_id) ?? advocates.set(a.cause_list_entry_id, []).get(a.cause_list_entry_id)!).push({ side: a.side, name_raw: a.name_raw, sequence: a.sequence_number });
  }
  return rows.map((r) => {
    let judges: string[] = [];
    try {
      judges = r.judges_json ? ((JSON.parse(r.judges_json) as { judges?: string[] }).judges ?? []) : [];
    } catch {
      /* ignore malformed judges_json */
    }
    const out: EntryResult & { raw_text?: string } = {
      entry_id: r.id,
      case_number_raw: r.case_number_raw,
      case_number_normalized: r.case_number_normalized,
      case_type: r.case_type,
      case_year: r.case_year,
      listing_date: r.listing_date,
      category_label_raw: r.category_label_raw,
      category_normalized: r.category_normalized,
      serial_number: r.serial_number,
      item_number: r.item_number,
      section_heading_raw: r.section_heading_raw,
      listing_note_raw: r.listing_note_raw,
      connected_cases: r.connected_cases_json ? (JSON.parse(r.connected_cases_json) as string[]) : [],
      court_label_raw: r.court_label_raw,
      bench_label_raw: r.bench_label_raw,
      judges,
      parties: parties.get(r.id) ?? [],
      advocates: advocates.get(r.id) ?? [],
      page_start: r.page_start,
      page_end: r.page_end,
      extraction_method: r.extraction_method,
      extraction_confidence: r.extraction_confidence,
      validation_status: r.validation_status,
      validation_flags: r.validation_flags_json ? (JSON.parse(r.validation_flags_json) as string[]) : [],
      source: {
        document_id: r.document_id,
        document_version_id: r.document_version_id,
        version_number: r.version_number,
        title: r.title,
        source_url: r.source_url,
        sha256: r.sha256,
        is_current_version: r.current_version_id === r.document_version_id,
      },
    };
    if (r.match_type) out.match_type = r.match_type;
    if (includeRaw) out.raw_text = r.raw_text;
    return out;
  });
}

export interface EntryQuery {
  where: Where;
  orderBy: string;
  /** Bound parameters for placeholders inside `orderBy` (bound after WHERE params). */
  orderParams?: unknown[];
  limit: number;
  offset: number;
  /** Extra select column producing `match_type`, with its own bound params placed first. */
  matchTypeSql?: { sql: string; params: unknown[] };
  includeRaw?: boolean;
}

export async function queryEntries(db: D1Database, q: EntryQuery): Promise<Page<EntryResult>> {
  const mt = q.matchTypeSql ? `, ${q.matchTypeSql.sql} AS match_type` : "";
  const total = (await first<{ n: number }>(db, `SELECT COUNT(*) AS n ${FROM_ENTRY} ${q.where.sql()}`, ...q.where.params))?.n ?? 0;
  const rows = await all<EntryRow>(
    db,
    `${SELECT_ENTRY}${mt} ${FROM_ENTRY} ${q.where.sql()} ORDER BY ${q.orderBy} LIMIT ? OFFSET ?`,
    ...(q.matchTypeSql?.params ?? []), ...q.where.params, ...(q.orderParams ?? []), q.limit, q.offset,
  );
  return pageOf(await hydrate(db, rows, q.includeRaw), total, q.offset, q.limit);
}

export interface SearchOutput {
  page: Page<EntryResult>;
  warnings: string[];
  groups?: Array<Record<string, unknown>>;
}

const ORDER_RECENT = "e.listing_date DESC, v.version_number DESC, d.id, e.entry_index";

// ------------------------------------------------------------------ case number

export async function searchCase(
  db: D1Database,
  input: { case_number: string; listing_date?: string | null; include_previous_versions?: boolean; limit?: number; cursor?: string | null },
): Promise<SearchOutput> {
  const limit = clampLimit(input.limit);
  const offset = decodeCursor(input.cursor);
  const common: CommonFilters = { listing_date: input.listing_date, include_previous_versions: input.include_previous_versions };
  const norm = normalizeCaseNumber(input.case_number);
  const warnings: string[] = [];

  if (norm) {
    const w = new Where();
    applyCommon(w, common);
    w.add("(e.case_number_normalized = ? OR e.case_number_key = ?)", norm.normalized, norm.key);
    const page = await queryEntries(db, {
      where: w, orderBy: ORDER_RECENT, limit, offset,
      matchTypeSql: { sql: "CASE WHEN e.case_number_normalized = ? THEN 'EXACT' ELSE 'EXACT_VARIANT' END", params: [norm.normalized] },
    });
    if (page.total > 0) {
      if (page.items.some((r) => r.match_type === "EXACT_VARIANT")) warnings.push("Some results match the case number only after ignoring punctuation differences (EXACT_VARIANT).");
      return { page, warnings };
    }
  }

  // No exact match: careful partial matching, clearly labelled.
  const w = new Where();
  applyCommon(w, common);
  const numYear = /^\s*(\d{1,7})\s*[/\s]\s*(\d{4})\s*$/.exec(input.case_number) ?? (norm ? [null, String(norm.caseNumber), String(norm.caseYear)] : null);
  if (numYear) {
    w.add("e.case_number_normalized LIKE ? ESCAPE '\\'", `%/${Number(numYear[1])}/${numYear[2]}`);
    warnings.push(norm
      ? `No entry matched ${norm.normalized} exactly. Showing PARTIAL matches with the same number and year but a different case type.`
      : "Only PARTIAL matches (same number/year, any case type) are shown.");
  } else {
    const q = input.case_number.toUpperCase().replace(/\s+/g, "");
    if (q.length < 3) throw invalid("case_number is too short for a partial search; provide e.g. WP(C)/1234/2026.");
    w.add("(e.case_number_normalized LIKE ? ESCAPE '\\' OR UPPER(REPLACE(e.case_number_raw, ' ', '')) LIKE ? ESCAPE '\\')", `%${likeEscape(q)}%`, `%${likeEscape(q)}%`);
    warnings.push("The input is not a complete case number; only PARTIAL text matches are shown.");
  }
  const page = await queryEntries(db, { where: w, orderBy: ORDER_RECENT, limit, offset, matchTypeSql: { sql: "'PARTIAL'", params: [] } });
  if (page.total === 0) warnings.push("No matching entry exists in the ingested dataset. This does not mean the case was not listed by the Court.");
  return { page, warnings };
}

// ------------------------------------------------------------------ party / advocate

function tokensOf(text: string): string[] {
  const n = normalizeName(text);
  if (!n) throw invalid("The name must contain letters or digits.");
  return n.split(" ").slice(0, 8);
}

async function searchPeople(
  db: D1Database,
  kind: "party" | "advocate",
  input: { name: string; side?: string | null; listing_date?: string | null; limit?: number; cursor?: string | null; include_previous_versions?: boolean },
): Promise<SearchOutput> {
  const limit = clampLimit(input.limit);
  const offset = decodeCursor(input.cursor);
  const tokens = tokensOf(input.name);
  const phrase = tokens.join(" ");
  const table = kind === "party" ? "case_parties" : "case_advocates";
  const normCol = kind === "party" ? "party_name_normalized" : "advocate_name_normalized";
  const ftsCol = kind === "party" ? "parties" : "advocates";
  const match = `${ftsCol}:(${tokens.map((t) => `"${t}"*`).join(" AND ")})`;

  const tokenLikes = tokens.map(() => `cp.${normCol} LIKE ? ESCAPE '\\'`).join(" AND ");
  const tokenParams = tokens.map((t) => `%${likeEscape(t)}%`);
  const sideSql = input.side ? "AND cp.side = ?" : "";
  const sideParams = input.side ? [input.side] : [];

  const w = new Where();
  applyCommon(w, { listing_date: input.listing_date, include_previous_versions: input.include_previous_versions });
  w.add("e.id IN (SELECT entry_id FROM cause_list_fts WHERE cause_list_fts MATCH ?)", match);
  // All tokens must occur in ONE person's name — never across different people.
  w.add(`EXISTS (SELECT 1 FROM ${table} cp WHERE cp.cause_list_entry_id = e.id ${sideSql} AND ${tokenLikes})`, ...sideParams, ...tokenParams);

  const phraseExists = `EXISTS (SELECT 1 FROM ${table} cp WHERE cp.cause_list_entry_id = e.id ${sideSql} AND cp.${normCol} LIKE ? ESCAPE '\\')`;
  const page = await queryEntries(db, {
    where: w,
    orderBy: `CASE WHEN ${phraseExists} THEN 0 ELSE 1 END, ${ORDER_RECENT}`,
    orderParams: [...sideParams, `%${likeEscape(phrase)}%`],
    limit, offset,
    matchTypeSql: { sql: `CASE WHEN ${phraseExists} THEN 'PHRASE' ELSE 'ALL_TOKENS' END`, params: [...sideParams, `%${likeEscape(phrase)}%`] },
  });
  const warnings = [
    `Names are matched on word prefixes after case/punctuation normalisation. Different spellings may refer to the same ${kind === "party" ? "party" : "advocate"}, and similar names may refer to different ones; no identities are merged.`,
  ];
  if (page.total === 0) warnings.push("No match in the ingested dataset. This does not mean the name was not listed by the Court.");
  return { page, warnings };
}

export const searchByParty = (db: D1Database, i: { party_name: string; side?: string | null; listing_date?: string | null; limit?: number; cursor?: string | null }) =>
  searchPeople(db, "party", { name: i.party_name, side: i.side, listing_date: i.listing_date, limit: i.limit, cursor: i.cursor });

export const searchByAdvocate = (db: D1Database, i: { advocate_name: string; side?: string | null; listing_date?: string | null; limit?: number; cursor?: string | null }) =>
  searchPeople(db, "advocate", { name: i.advocate_name, side: i.side, listing_date: i.listing_date, limit: i.limit, cursor: i.cursor });

// ------------------------------------------------------------------ court / bench / date

export function courtClause(w: Where, courtQuery: string): void {
  const justNumber = /^\s*(?:court\s*(?:no\.?|number)?\s*[:.-]?\s*)?([A-Za-z]?\d{1,4})\s*$/i.exec(courtQuery);
  if (justNumber) {
    w.add("b.court_number_normalized = ?", normalizeCourtNumber(`COURT NO ${justNumber[1]}`) ?? justNumber[1]!.toUpperCase());
  } else {
    w.add("UPPER(b.court_label_raw) LIKE ? ESCAPE '\\'", `%${likeEscape(courtQuery.trim().toUpperCase())}%`);
  }
}

function benchClause(w: Where, benchQuery: string): void {
  const p = `%${likeEscape(benchQuery.trim().toUpperCase())}%`;
  w.add("(UPPER(b.bench_label_raw) LIKE ? ESCAPE '\\' OR UPPER(b.judges_json) LIKE ? ESCAPE '\\' OR UPPER(b.court_label_raw) LIKE ? ESCAPE '\\')", p, p, p);
}

const ORDER_DOC = "d.listing_date DESC, d.category_normalized, d.id, e.entry_index";

function groupsOf(items: EntryResult[]): Array<Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown> & { entry_count: number }>();
  for (const r of items) {
    const key = `${r.source.document_id}|${r.court_label_raw}|${r.bench_label_raw}`;
    const g = map.get(key) ?? { document_id: r.source.document_id, document_version_id: r.source.document_version_id, title: r.source.title, listing_date: r.listing_date, category_label_raw: r.category_label_raw, court_label_raw: r.court_label_raw, bench_label_raw: r.bench_label_raw, judges: r.judges, entry_count: 0 };
    g.entry_count++;
    map.set(key, g);
  }
  return [...map.values()];
}

/** Serial numbers in a court section should be contiguous within a list; gaps hint at incomplete extraction. */
function completenessWarnings(items: EntryResult[], total: number): string[] {
  const warnings: string[] = [];
  if (items.length < total) warnings.push(`Only ${items.length} of ${total} matching entries are in this page; use next_cursor for the rest.`);
  const bad = items.filter((i) => i.validation_status !== "VALIDATED").length;
  if (bad) warnings.push(`${bad} entr${bad === 1 ? "y has" : "ies have"} uncertain extraction (validation_status != VALIDATED); verify against the source PDF page.`);
  if (items.length === total) {
    const bySection = new Map<string, number[]>();
    for (const i of items) {
      const n = i.serial_number && /^\d+$/.test(i.serial_number) ? Number(i.serial_number) : null;
      if (n === null) continue;
      const k = `${i.source.document_version_id}|${i.court_label_raw}|${i.bench_label_raw}`;
      (bySection.get(k) ?? bySection.set(k, []).get(k)!).push(n);
    }
    for (const nums of bySection.values()) {
      const set = new Set(nums);
      const max = Math.max(...nums);
      const missing: number[] = [];
      for (let n = Math.min(...nums); n <= max && missing.length < 5; n++) if (!set.has(n)) missing.push(n);
      if (missing.length) { warnings.push(`Serial numbers are not contiguous in one court section (e.g. missing ${missing.join(", ")}); the section may be incomplete or the list may skip numbers.`); break; }
    }
  }
  return warnings;
}

export async function searchByCourt(
  db: D1Database,
  i: { court_query: string; listing_date?: string | null; category?: string | null; document_id?: string | null; limit?: number; cursor?: string | null },
): Promise<SearchOutput> {
  const limit = clampLimit(i.limit, 100);
  const w = new Where();
  applyCommon(w, { listing_date: i.listing_date, category: i.category, document_id: i.document_id });
  courtClause(w, i.court_query);
  const page = await queryEntries(db, { where: w, orderBy: ORDER_DOC, limit, offset: decodeCursor(i.cursor) });
  return { page, warnings: completenessWarnings(page.items, page.total), groups: groupsOf(page.items) };
}

export async function searchByBench(
  db: D1Database,
  i: { bench_query: string; listing_date?: string | null; category?: string | null; limit?: number; cursor?: string | null },
): Promise<SearchOutput> {
  const limit = clampLimit(i.limit, 100);
  const w = new Where();
  applyCommon(w, { listing_date: i.listing_date, category: i.category });
  benchClause(w, i.bench_query);
  const page = await queryEntries(db, { where: w, orderBy: ORDER_DOC, limit, offset: decodeCursor(i.cursor) });
  const warnings = completenessWarnings(page.items, page.total);
  warnings.push("Bench matching is a substring search over the bench heading and judge names exactly as printed in the cause list.");
  return { page, warnings, groups: groupsOf(page.items) };
}

export async function casesByDate(
  db: D1Database,
  i: { listing_date: string; category?: string | null; court_query?: string | null; limit?: number; cursor?: string | null },
): Promise<SearchOutput> {
  const limit = clampLimit(i.limit, 100);
  const w = new Where();
  applyCommon(w, { listing_date: i.listing_date, category: i.category });
  if (i.court_query) courtClause(w, i.court_query);
  const page = await queryEntries(db, { where: w, orderBy: ORDER_DOC, limit, offset: decodeCursor(i.cursor) });
  const warnings = completenessWarnings(page.items, page.total);
  if (page.total === 0) warnings.push("No extracted entries for this date in the ingested dataset (the list may not be published, downloaded or parsed yet).");
  return { page, warnings, groups: groupsOf(page.items) };
}

// ------------------------------------------------------------------ single entry

export async function getEntryDetails(
  db: D1Database,
  i: { entry_id?: string | null; case_number?: string | null; listing_date?: string | null; document_id?: string | null; include_raw_text?: boolean },
): Promise<EntryResult & { raw_text?: string }> {
  const w = new Where();
  if (i.entry_id) {
    w.add("e.id = ?", i.entry_id);
  } else if (i.case_number) {
    const norm = normalizeCaseNumber(i.case_number);
    if (!norm) throw invalid("case_number must look like TYPE/NUMBER/YEAR, e.g. WP(C)/1234/2026.");
    applyCommon(w, { listing_date: i.listing_date, document_id: i.document_id });
    w.add("e.case_number_normalized = ?", norm.normalized);
  } else {
    throw invalid("Provide entry_id, or case_number with a listing_date/document_id selector.");
  }
  const page = await queryEntries(db, { where: w, orderBy: ORDER_RECENT, limit: 11, offset: 0, includeRaw: i.include_raw_text ?? false });
  if (page.items.length === 0) throw notFound("The cause-list entry");
  if (page.items.length > 1) {
    throw invalid(`The selector is ambiguous (${page.total} entries). Narrow it with listing_date/document_id or use an entry_id from a search result: ${page.items.slice(0, 5).map((r) => r.entry_id).join(", ")}`);
  }
  return page.items[0]!;
}

// ------------------------------------------------------------------ available dates & documents

export async function availableDates(
  db: D1Database,
  i: { from_date?: string | null; to_date?: string | null; category?: string | null; limit?: number },
) {
  const limit = clampLimit(i.limit, 100);
  const w = new Where().add("d.listing_date IS NOT NULL").add("d.current_version_id IS NOT NULL");
  if (i.from_date) { if (!ISO_DATE.test(i.from_date)) throw invalid("from_date must be YYYY-MM-DD."); w.add("d.listing_date >= ?", i.from_date); }
  if (i.to_date) { if (!ISO_DATE.test(i.to_date)) throw invalid("to_date must be YYYY-MM-DD."); w.add("d.listing_date <= ?", i.to_date); }
  if (i.category) applyCategory(w, i.category);
  const dates = await all<{ listing_date: string }>(db, `SELECT DISTINCT d.listing_date FROM cause_list_documents d ${w.sql()} ORDER BY d.listing_date DESC LIMIT ?`, ...w.params, limit);
  if (dates.length === 0) return [];
  const w2 = new Where().add("d.current_version_id IS NOT NULL").add(`d.listing_date IN (${placeholders(dates.length)})`, ...dates.map((d) => d.listing_date));
  if (i.category) applyCategory(w2, i.category);
  const rows = await all<{ listing_date: string; category_label_raw: string | null; category_normalized: string | null; n: number; parsed: number }>(
    db,
    `SELECT d.listing_date, d.category_label_raw, d.category_normalized, COUNT(*) AS n,
            SUM(CASE WHEN v.extraction_status IN ('EXTRACTED','PARTIALLY_EXTRACTED','REVIEW_REQUIRED') THEN 1 ELSE 0 END) AS parsed
       FROM cause_list_documents d JOIN document_versions v ON v.id = d.current_version_id ${w2.sql()}
      GROUP BY d.listing_date, d.category_label_raw, d.category_normalized ORDER BY d.listing_date DESC, d.category_label_raw`,
    ...w2.params,
  );
  return dates.map((d) => {
    const cats = rows.filter((r) => r.listing_date === d.listing_date);
    return {
      date: d.listing_date,
      document_count: cats.reduce((s, c) => s + c.n, 0),
      categories: cats.map((c) => ({ category_label_raw: c.category_label_raw, category_normalized: c.category_normalized, document_count: c.n, parsed_document_count: c.parsed })),
    };
  });
}

export interface DocumentSummary {
  document_id: string;
  title: string | null;
  category_label_raw: string | null;
  category_normalized: string | null;
  listing_date: string | null;
  listing_date_raw: string | null;
  publication_label: string | null;
  source_url: string;
  status: string;
  current_version_id: string | null;
  version_number: number | null;
  extraction_status: string | null;
  sha256: string | null;
  page_count: number | null;
  last_seen_at: string;
}

export async function listDocuments(
  db: D1Database,
  i: { listing_date?: string | null; category?: string | null; limit?: number; cursor?: string | null },
): Promise<Page<DocumentSummary>> {
  const limit = clampLimit(i.limit, 50);
  const offset = decodeCursor(i.cursor);
  const w = new Where();
  if (i.listing_date) { if (!ISO_DATE.test(i.listing_date)) throw invalid("listing_date must be YYYY-MM-DD."); w.add("d.listing_date = ?", i.listing_date); }
  if (i.category) applyCategory(w, i.category);
  const from = `FROM cause_list_documents d LEFT JOIN document_versions v ON v.id = d.current_version_id`;
  const total = (await first<{ n: number }>(db, `SELECT COUNT(*) AS n ${from} ${w.sql()}`, ...w.params))?.n ?? 0;
  const rows = await all<DocumentSummary>(
    db,
    `SELECT d.id AS document_id, d.title, d.category_label_raw, d.category_normalized, d.listing_date, d.listing_date_raw,
            d.publication_label, d.source_url, d.status, d.current_version_id, v.version_number, v.extraction_status,
            v.sha256, v.page_count, d.last_seen_at
       ${from} ${w.sql()} ORDER BY COALESCE(d.listing_date, '0000') DESC, d.category_normalized, d.source_url LIMIT ? OFFSET ?`,
    ...w.params, limit, offset,
  );
  return pageOf(rows, total, offset, limit);
}
