#!/usr/bin/env node
// Acceptance walk-through against a RUNNING Worker, using the real MCP SDK client (validates structured output against each tool's schema).
//   MCP_URL=http://localhost:8787/mcp MCP_TOKEN=... CASE=WA/225/2024 DATE=2026-11-02 node tests/mcp-client/acceptance.mjs
// Use a case number that is really present in a PDF you ingested; check the printed page against the PDF.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_URL ?? "http://localhost:8787/mcp";
const token = process.env.MCP_TOKEN;
const caseNo = process.env.CASE;
const date = process.env.DATE;
if (!caseNo || !date) { console.error("Set CASE (e.g. WA/225/2024) and DATE (YYYY-MM-DD) for a case you know is in an ingested PDF."); process.exit(2); }

const c = new Client({ name: "acceptance", version: "1.0.0" });
await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: token ? { authorization: `Bearer ${token}` } : {} } }));
const call = async (name, args) => { const r = await c.callTool({ name, arguments: args }); if (r.isError) throw new Error(`${name}: ${r.content[0].text}`); return r.structuredContent; };
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) process.exitCode = 1; };

ok((await c.listTools()).tools.length === 17, "17 tools listed");
const dates = await call("get_available_dates", {});
ok(dates.dates.some((d) => d.date === date), `date ${date} is available`);
const s = await call("search_case", { case_number: caseNo, listing_date: date });
const e = s.results[0];
ok(s.total >= 1 && e?.match_type === "EXACT", `search_case ${caseNo} → EXACT (${s.total} result(s))`);
console.log(`      serial ${e?.serial_number} | ${e?.court_label_raw} ${e?.bench_label_raw ?? ""} | PDF page ${e?.page_start} | ${e?.source.source_url} | sha256 ${e?.source.sha256.slice(0, 12)}…`);
console.log(`      parties: ${e?.parties.map((p) => p.name_raw).join("  vs  ")}`);
const page = await call("get_document_page", { document_version_id: e.source.document_version_id, page_number: e.page_start });
ok(page.page.text_content.includes(caseNo), "cited PDF page text contains the case number");
const party = await call("search_by_party", { party_name: e.parties[0].name_raw, listing_date: date });
ok(party.results.some((r) => r.entry_id === e.entry_id), "search_by_party finds the same entry");
const adv = e.advocates[0];
if (adv) ok((await call("search_by_advocate", { advocate_name: adv.name_raw, side: adv.side, listing_date: date })).results.some((r) => r.entry_id === e.entry_id), "search_by_advocate finds the same entry");
const det = await call("get_case_details", { entry_id: e.entry_id, include_raw_text: true });
ok(det.entry.raw_text.includes(caseNo), "get_case_details returns the raw text");
const sum = await call("summarize_cause_list", { listing_date: date, category: e.category_normalized ?? undefined });
ok(sum.counts.total_entries >= 1 && sum.documents.length >= 1, `summarize_cause_list cites ${sum.documents.length} document(s) with SQL counts (AI summary ${sum.ai_generated ? "generated" : "unavailable: " + sum.ai_error?.kind})`);
await c.close();
