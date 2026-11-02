import { getVersion } from "../repositories/ingestion.repo";
import { all } from "../repositories/db";
import { invalid, notFound } from "../utils/errors";

interface Row {
  id: string; case_number_normalized: string | null; case_number_raw: string | null; serial_number: string | null;
  listing_note_raw: string | null; section_heading_raw: string | null; court_label_raw: string | null; bench_label_raw: string | null;
  page_start: number | null; raw_text: string; parties: string | null; advocates: string | null;
}

export interface EntrySnapshot {
  entry_id: string; case_number: string | null; serial_number: string | null; court_label_raw: string | null;
  bench_label_raw: string | null; section_heading_raw: string | null; page_start: number | null;
}

export interface Comparison {
  document_id: string;
  older_version_id: string;
  newer_version_id: string;
  counts: { older_entries: number; newer_entries: number; added: number; removed: number; changed: number; unchanged: number; ambiguous: number };
  added: EntrySnapshot[];
  removed: EntrySnapshot[];
  changed: Array<{ case_number: string | null; before: EntrySnapshot; after: EntrySnapshot; changed_fields: string[] }>;
  ambiguous: Array<{ case_number: string | null; older: EntrySnapshot[]; newer: EntrySnapshot[]; reason: string }>;
  caveats: string[];
}

const LOAD = `
  SELECT e.id, e.case_number_normalized, e.case_number_raw, e.serial_number, e.listing_note_raw, e.section_heading_raw,
         b.court_label_raw, b.bench_label_raw, e.page_start, e.raw_text,
         (SELECT GROUP_CONCAT(party_name_raw, ' | ') FROM case_parties WHERE cause_list_entry_id = e.id) AS parties,
         (SELECT GROUP_CONCAT(side || ':' || advocate_name_raw, ' | ') FROM case_advocates WHERE cause_list_entry_id = e.id) AS advocates
    FROM cause_list_entries e LEFT JOIN court_benches b ON b.id = e.court_bench_id
   WHERE e.document_version_id = ? ORDER BY e.entry_index`;

const snap = (r: Row): EntrySnapshot => ({
  entry_id: r.id, case_number: r.case_number_normalized ?? r.case_number_raw, serial_number: r.serial_number,
  court_label_raw: r.court_label_raw, bench_label_raw: r.bench_label_raw, section_heading_raw: r.section_heading_raw, page_start: r.page_start,
});

const contextKey = (r: Row) => `${r.court_label_raw ?? ""}|${r.bench_label_raw ?? ""}`;
/** Entries without a normalized case number are keyed by their raw text so they can still be diffed. */
const caseKey = (r: Row) => r.case_number_normalized ?? `RAW:${r.case_number_raw ?? r.raw_text.slice(0, 120)}`;

const FIELDS: Array<[string, (r: Row) => string | null]> = [
  ["serial_number", (r) => r.serial_number], ["court", (r) => r.court_label_raw], ["bench", (r) => r.bench_label_raw],
  ["section_heading", (r) => r.section_heading_raw], ["listing_note", (r) => r.listing_note_raw],
  ["parties", (r) => r.parties], ["advocates", (r) => r.advocates],
];

/**
 * Record-level diff between two versions of the SAME logical document, using only extracted data.
 * Matches by normalized case number, then by court/bench context. Anything not uniquely matchable
 * is reported as ambiguous, never forced into added/removed.
 */
export async function compareVersions(db: D1Database, documentId: string, olderId: string, newerId: string): Promise<Comparison> {
  const [older, newer] = await Promise.all([getVersion(db, olderId), getVersion(db, newerId)]);
  if (!older || !newer) throw notFound("One of the document versions");
  if (older.document_id !== documentId || newer.document_id !== documentId) throw invalid("Both versions must belong to the given document_id.");
  if (older.id === newer.id) throw invalid("older_version_id and newer_version_id must differ.");
  const [a, b] = await Promise.all([all<Row>(db, LOAD, olderId), all<Row>(db, LOAD, newerId)]);

  const group = (rows: Row[]) => {
    const m = new Map<string, Row[]>();
    for (const r of rows) (m.get(caseKey(r)) ?? m.set(caseKey(r), []).get(caseKey(r))!).push(r);
    return m;
  };
  const ga = group(a), gb = group(b);
  const out: Comparison = {
    document_id: documentId, older_version_id: olderId, newer_version_id: newerId,
    counts: { older_entries: a.length, newer_entries: b.length, added: 0, removed: 0, changed: 0, unchanged: 0, ambiguous: 0 },
    added: [], removed: [], changed: [], ambiguous: [],
    caveats: [
      "Comparison covers extracted records only; parsing errors can appear as spurious differences.",
      "A removed entry does NOT mean a matter was disposed of, and a changed serial number is NOT a legal event. Consult the source PDFs.",
    ],
  };

  const diff = (x: Row, y: Row) => FIELDS.filter(([, f]) => (f(x) ?? "") !== (f(y) ?? "")).map(([n]) => n);
  const consider = (x: Row, y: Row, key: string) => {
    const fields = diff(x, y);
    if (fields.length) out.changed.push({ case_number: key.startsWith("RAW:") ? null : key, before: snap(x), after: snap(y), changed_fields: fields });
    else out.counts.unchanged++;
  };

  for (const [key, xs] of ga) {
    const ys = gb.get(key);
    if (!ys) { xs.forEach((x) => out.removed.push(snap(x))); continue; }
    if (xs.length === 1 && ys.length === 1) { consider(xs[0]!, ys[0]!, key); continue; }
    // Several entries share a case number (e.g. listed in more than one court section): pair by context.
    const used = new Set<string>();
    const unmatchedOld: Row[] = [];
    for (const x of xs) {
      const cands = ys.filter((y) => !used.has(y.id) && contextKey(y) === contextKey(x));
      if (cands.length === 1) { used.add(cands[0]!.id); consider(x, cands[0]!, key); } else unmatchedOld.push(x);
    }
    const unmatchedNew = ys.filter((y) => !used.has(y.id));
    if (unmatchedOld.length || unmatchedNew.length) {
      out.ambiguous.push({ case_number: key.startsWith("RAW:") ? null : key, older: unmatchedOld.map(snap), newer: unmatchedNew.map(snap), reason: "Multiple entries share this case number and could not be paired uniquely by court/bench context." });
    }
  }
  for (const [key, ys] of gb) if (!ga.has(key)) ys.forEach((y) => out.added.push(snap(y)));

  out.counts.added = out.added.length; out.counts.removed = out.removed.length;
  out.counts.changed = out.changed.length; out.counts.ambiguous = out.ambiguous.length;
  return out;
}
