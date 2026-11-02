import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compareVersions } from "../../services/compare.service";
import { explainTerms, summarizeCauseList } from "../../services/ai.service";
import { getDocumentDetails, getDocumentPage } from "../../services/document.service";
import {
  availableDates, casesByDate, getEntryDetails, listDocuments, searchByAdvocate, searchByBench, searchByCourt, searchByParty,
  searchCase, type SearchOutput,
} from "../../services/search.service";
import { freshnessWarnings, getIngestionStatus } from "../../services/status.service";
import { courtQuery, cursorField, categoryField, DISCLAIMER, isoDate, limitField, listEnvelope, plainEnvelope, sideField, textQuery } from "../schemas";
import { defineTool, type ToolContext } from "./define";

const nz = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const { env, cfg } = ctx;

  async function listResult(query: Record<string, unknown>, out: SearchOutput, label: string) {
    const warnings = [...(await freshnessWarnings(env.DB, cfg)), ...out.warnings];
    return {
      summary: `${label}: ${out.page.total} match(es), showing ${out.page.items.length}.${out.page.next_cursor ? " More available via next_cursor." : ""}`,
      data: {
        success: true, query, results: out.page.items, total: out.page.total, limit: out.page.limit, next_cursor: out.page.next_cursor,
        ...(out.groups ? { groups: out.groups } : {}), warnings, disclaimer: DISCLAIMER,
      },
    };
  }

  defineTool(server, ctx, "get_available_dates", {
    title: "Get available cause-list dates",
    description: "List listing dates for which at least one cause-list PDF has been downloaded into the dataset, with category labels and document counts. Reports the ingested dataset, not a guarantee of what the Court has published.",
    input: { from_date: isoDate.nullish(), to_date: isoDate.nullish(), category: categoryField, limit: limitField },
    output: { ...plainEnvelope, dates: z.array(z.unknown()) },
  }, async (a) => {
    const dates = await availableDates(env.DB, { from_date: a.from_date, to_date: a.to_date, category: a.category, limit: a.limit ?? undefined });
    const warnings = [...(await freshnessWarnings(env.DB, cfg)), "Dates shown are those present in the ingested dataset; absence of a date does not mean the Court published no list, only that none has been ingested."];
    return { summary: `${dates.length} date(s) available.`, data: { success: true, dates, warnings, disclaimer: DISCLAIMER } };
  });

  defineTool(server, ctx, "get_cause_lists", {
    title: "Get cause-list documents",
    description: "Return cause-list document metadata (title, category, source URL, version, extraction status) for a date and/or category. Includes documents not yet downloaded or parsed, with their honest status.",
    input: { listing_date: isoDate.nullish(), category: categoryField, limit: limitField, cursor: cursorField },
    output: listEnvelope,
  }, async (a) => {
    const page = await listDocuments(env.DB, { listing_date: a.listing_date, category: a.category, limit: a.limit ?? undefined, cursor: a.cursor });
    const warnings = await freshnessWarnings(env.DB, cfg);
    if (page.total === 0) warnings.push("No documents match. The list may not have been published or discovered yet.");
    return { summary: `${page.total} document(s).`, data: { success: true, query: { listing_date: nz(a.listing_date) ?? null, category: nz(a.category) ?? null }, results: page.items, total: page.total, limit: page.limit, next_cursor: page.next_cursor, warnings, disclaimer: DISCLAIMER } };
  });

  defineTool(server, ctx, "search_case", {
    title: "Search by case number",
    description: "Find cause-list entries by case number. Exact normalized matches rank first (match_type EXACT / EXACT_VARIANT); partial matches are returned only when there is no exact match and are labelled PARTIAL. Returns court/bench, serial number, parties, advocates and PDF page reference.",
    input: { case_number: textQuery("case_number").describe("e.g. WP(C)/1234/2026"), listing_date: isoDate.nullish(), include_previous_versions: z.boolean().nullish(), limit: limitField, cursor: cursorField },
    output: listEnvelope,
  }, async (a) => {
    const out = await searchCase(env.DB, { case_number: a.case_number, listing_date: a.listing_date, include_previous_versions: a.include_previous_versions ?? false, limit: a.limit ?? undefined, cursor: a.cursor });
    return listResult({ case_number: a.case_number, listing_date: nz(a.listing_date) ?? null }, out, "Case search");
  });

  defineTool(server, ctx, "search_by_party", {
    title: "Search by party name",
    description: "Find entries by party (litigant) name using normalized + full-text matching. Source spelling is preserved; similar names are never merged. All words must appear in a single party name.",
    input: { party_name: textQuery("party_name"), side: sideField, listing_date: isoDate.nullish(), limit: limitField, cursor: cursorField },
    output: listEnvelope,
  }, async (a) => listResult({ party_name: a.party_name, side: nz(a.side) ?? null, listing_date: nz(a.listing_date) ?? null },
    await searchByParty(env.DB, { party_name: a.party_name, side: a.side, listing_date: a.listing_date, limit: a.limit ?? undefined, cursor: a.cursor }), "Party search"));

  defineTool(server, ctx, "search_by_advocate", {
    title: "Search by advocate name",
    description: "Find entries by advocate name as printed in the list. Similar names are not assumed to be the same advocate. 'side' refers to the Petitioner/Respondent advocate column.",
    input: { advocate_name: textQuery("advocate_name"), side: sideField, listing_date: isoDate.nullish(), limit: limitField, cursor: cursorField },
    output: listEnvelope,
  }, async (a) => listResult({ advocate_name: a.advocate_name, side: nz(a.side) ?? null, listing_date: nz(a.listing_date) ?? null },
    await searchByAdvocate(env.DB, { advocate_name: a.advocate_name, side: a.side, listing_date: a.listing_date, limit: a.limit ?? undefined, cursor: a.cursor }), "Advocate search"));

  defineTool(server, ctx, "search_by_court", {
    title: "Search by court",
    description: "Return entries listed under a court heading (e.g. 'Court No. 3' or just '3'), grouped by document and heading, using the labels printed in the cause list.",
    input: { court_query: courtQuery, listing_date: isoDate.nullish(), category: categoryField, limit: limitField, cursor: cursorField },
    output: { ...listEnvelope, groups: z.array(z.unknown()).optional() },
  }, async (a) => listResult({ court_query: a.court_query, listing_date: nz(a.listing_date) ?? null, category: nz(a.category) ?? null },
    await searchByCourt(env.DB, { court_query: a.court_query, listing_date: a.listing_date, category: a.category, limit: a.limit ?? undefined, cursor: a.cursor }), "Court search"));

  defineTool(server, ctx, "search_by_bench", {
    title: "Search by bench or judge",
    description: "Search stored bench headings and judge names exactly as printed in the extracted cause lists. Does not use external knowledge of judge assignments.",
    input: { bench_query: textQuery("bench_query"), listing_date: isoDate.nullish(), category: categoryField, limit: limitField, cursor: cursorField },
    output: { ...listEnvelope, groups: z.array(z.unknown()).optional() },
  }, async (a) => listResult({ bench_query: a.bench_query, listing_date: nz(a.listing_date) ?? null },
    await searchByBench(env.DB, { bench_query: a.bench_query, listing_date: a.listing_date, category: a.category, limit: a.limit ?? undefined, cursor: a.cursor }), "Bench search"));

  defineTool(server, ctx, "get_case_details", {
    title: "Get one cause-list entry",
    description: "Return a single extracted entry with provenance (document, version hash, PDF page range) and extraction quality. Select by entry_id, or by case_number plus listing_date/document_id when unambiguous.",
    input: { entry_id: z.string().max(100).nullish(), case_number: z.string().max(100).nullish(), listing_date: isoDate.nullish(), document_id: z.string().max(100).nullish(), include_raw_text: z.boolean().nullish() },
    output: { ...plainEnvelope, entry: z.unknown() },
  }, async (a) => {
    const entry = await getEntryDetails(env.DB, { entry_id: a.entry_id, case_number: a.case_number, listing_date: a.listing_date, document_id: a.document_id, include_raw_text: a.include_raw_text ?? true });
    const warnings = entry.validation_status !== "VALIDATED" ? ["This entry has uncertain extraction; verify it against the cited PDF page."] : [];
    return { summary: `Entry ${entry.case_number_raw ?? entry.entry_id} on PDF page ${entry.page_start}.`, data: { success: true, entry, warnings, disclaimer: DISCLAIMER } };
  });

  defineTool(server, ctx, "get_cases_by_date", {
    title: "Get cases listed on a date",
    description: "Paginated entries for a listing date. If a date has several lists (Daily, Supplementary, Lawazima…), each document's entries are kept distinct via the source fields.",
    input: { listing_date: isoDate, category: categoryField, court_query: z.string().max(100).nullish(), limit: limitField, cursor: cursorField },
    output: { ...listEnvelope, groups: z.array(z.unknown()).optional() },
  }, async (a) => listResult({ listing_date: a.listing_date, category: nz(a.category) ?? null, court_query: nz(a.court_query) ?? null },
    await casesByDate(env.DB, { listing_date: a.listing_date, category: a.category, court_query: a.court_query, limit: a.limit ?? undefined, cursor: a.cursor }), "Cases by date"));

  defineTool(server, ctx, "get_court_schedule", {
    title: "Get a court's schedule",
    description: "Entries parsed under a court heading for a date, in printed order, with extraction warnings (e.g. non-contiguous serial numbers) when the section may be incomplete.",
    input: { listing_date: isoDate, court_query: courtQuery, document_id: z.string().max(100).nullish(), limit: limitField, cursor: cursorField },
    output: { ...listEnvelope, groups: z.array(z.unknown()).optional() },
  }, async (a) => listResult({ listing_date: a.listing_date, court_query: a.court_query, document_id: nz(a.document_id) ?? null },
    await searchByCourt(env.DB, { court_query: a.court_query, listing_date: a.listing_date, document_id: a.document_id, limit: a.limit ?? undefined, cursor: a.cursor }), "Court schedule"));

  defineTool(server, ctx, "get_bench_schedule", {
    title: "Get a bench's schedule",
    description: "Entries under a bench heading or judge name for a date, as printed in the extracted lists.",
    input: { listing_date: isoDate, bench_query: textQuery("bench_query"), limit: limitField, cursor: cursorField },
    output: { ...listEnvelope, groups: z.array(z.unknown()).optional() },
  }, async (a) => listResult({ listing_date: a.listing_date, bench_query: a.bench_query },
    await searchByBench(env.DB, { bench_query: a.bench_query, listing_date: a.listing_date, limit: a.limit ?? undefined, cursor: a.cursor }), "Bench schedule"));

  defineTool(server, ctx, "get_document", {
    title: "Get document details",
    description: "Document metadata: title, source and final URL, category (raw and normalized), version/hash history, page count, stored-object availability and extraction status. May include a short-lived signed download path for the stored PDF when signing is configured.",
    input: { document_id: z.string().min(1).max(100), version_id: z.string().max(100).nullish() },
    output: { ...plainEnvelope, document: z.unknown(), version: z.unknown(), versions: z.array(z.unknown()), download: z.unknown() },
  }, async (a) => {
    const d = await getDocumentDetails(env, cfg, a.document_id, a.version_id);
    return { summary: `${d.document.title ?? d.document.document_id} (${d.versions.length} version(s)).`, data: { success: true, ...d, warnings: [], disclaimer: DISCLAIMER } };
  });

  defineTool(server, ctx, "get_document_page", {
    title: "Get extracted page text",
    description: "Extracted text of one PDF page (1-based) with extraction method, page status and provenance (document, version, source URL).",
    input: { document_version_id: z.string().min(1).max(100), page_number: z.number().int().min(1).max(100000) },
    output: { ...plainEnvelope, page: z.unknown() },
  }, async (a) => {
    const page = await getDocumentPage(env.DB, a.document_version_id, a.page_number);
    return { summary: `Page ${page.page_number} of ${page.page_count ?? "?"}.`, data: { success: true, page, warnings: page.page_status === "OK" ? [] : [`Page status is ${page.page_status}; text may be incomplete.`], disclaimer: DISCLAIMER } };
  });

  defineTool(server, ctx, "compare_cause_lists", {
    title: "Compare two versions of a cause list",
    description: "Record-level diff (added / removed / changed / ambiguous entries) between two versions of the same document, using extracted data only. Removal does not mean disposal; a serial-number change is not a legal event.",
    input: { document_id: z.string().min(1).max(100), older_version_id: z.string().min(1).max(100), newer_version_id: z.string().min(1).max(100) },
    output: { ...plainEnvelope, comparison: z.unknown() },
  }, async (a) => {
    const c = await compareVersions(env.DB, a.document_id, a.older_version_id, a.newer_version_id);
    return { summary: `+${c.counts.added} added, -${c.counts.removed} removed, ${c.counts.changed} changed, ${c.counts.ambiguous} ambiguous.`, data: { success: true, comparison: c, warnings: c.caveats, disclaimer: DISCLAIMER } };
  });

  defineTool(server, ctx, "get_ingestion_status", {
    title: "Get ingestion status",
    description: "Latest crawl times, pending/failed job counts, extraction status counts and data freshness. Detailed internal errors are not exposed to MCP clients.",
    input: { from_date: isoDate.nullish(), to_date: isoDate.nullish(), include_errors: z.boolean().nullish() },
    output: { ...plainEnvelope, status: z.unknown() },
  }, async (a) => {
    const status = await getIngestionStatus(env, cfg, { from_date: a.from_date, to_date: a.to_date, include_errors: a.include_errors ?? false }, false);
    return { summary: "Ingestion status.", data: { success: true, status, warnings: (status as { data_freshness: { warnings: string[] } }).data_freshness.warnings, disclaimer: DISCLAIMER } };
  });

  defineTool(server, ctx, "summarize_cause_list", {
    title: "Summarize a cause list (AI)",
    description: "AI-generated summary of retrieved cause-list entries. Counts and document/page references are computed by SQL; the AI only explains them and cannot add entries. Falls back to the exact counts if the AI provider is unavailable.",
    input: { listing_date: isoDate, category: categoryField, court_query: z.string().max(100).nullish(), question: z.string().max(500).nullish(), max_entries: z.number().int().min(1).max(200).nullish() },
    output: { ...plainEnvelope, counts: z.unknown(), documents: z.array(z.unknown()), ai_generated: z.boolean(), ai_summary: z.string().nullable() },
    ai: true,
  }, async (a) => {
    const r = await summarizeCauseList(env, cfg, ctx.llm, { listing_date: a.listing_date, category: a.category, court_query: a.court_query, question: a.question, max_entries: a.max_entries ?? undefined });
    const warnings = [...(await freshnessWarnings(env.DB, cfg)), ...r.warnings];
    return { summary: r.ai_summary ? "AI-generated summary (verify against the official PDF)." : "Exact counts only (no AI summary).", data: { success: true, ...r, warnings, disclaimer: DISCLAIMER } };
  });

  defineTool(server, ctx, "explain_cause_list_terms", {
    title: "Explain cause-list terminology (AI)",
    description: "AI explanation of general cause-list terminology. Separates general background from anything explicitly present in the optional source_context. Not legal advice.",
    input: { term_or_question: z.string().trim().min(2).max(500), source_context: z.string().max(2000).nullish() },
    output: { ...plainEnvelope, explanation: z.string(), ai_generated: z.boolean(), caveat: z.string() },
    ai: true,
  }, async (a) => {
    const r = await explainTerms(env, ctx.llm, { term_or_question: a.term_or_question, source_context: a.source_context });
    return { summary: "AI-generated explanation (general background, not legal advice).", data: { success: true, ...r, warnings: [], disclaimer: DISCLAIMER } };
  });
}
