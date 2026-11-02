import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSourcePage } from "../src/crawler/parse-source-page";

/** Opt-in: LIVE_HTML=/path/to/saved/consolidated-cause-list.html npm test -- live.page */
const path = process.env.LIVE_HTML;
describe.skipIf(!path || !existsSync(path))("full live page capture", () => {
  it("parses every link, with statistics", () => {
    const html = readFileSync(path!, "utf8");
    const p = parseSourcePage(html, "https://ghconline.gov.in/index.php/consolidated-cause-list/", "ghc_consolidated_cause_list", "t");
    const links = new Set([...html.matchAll(/href="(https:\/\/ghconline\.gov\.in\/NewCList\/[^"]+\.pdf)"/g)].map((m) => m[1]));
    const status: Record<string, number> = {};
    const cats: Record<string, number> = {};
    for (const d of p.documents) { status[d.dateParseStatus] = (status[d.dateParseStatus] ?? 0) + 1; cats[`${d.categoryLabelRaw}|${d.categoryNormalized}`] = (cats[`${d.categoryLabelRaw}|${d.categoryNormalized}`] ?? 0) + 1; }
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ unique_links_in_html: links.size, documents: p.documents.length, status, cats, warnings: p.warnings.slice(0, 5), conflicts: p.documents.filter((d) => d.dateParseStatus === "CONFLICT" || d.dateParseStatus === "UNPARSED").map((d) => d.sourceFilename) }, null, 1));
    expect(p.documents.length).toBe(links.size);
  });
});
