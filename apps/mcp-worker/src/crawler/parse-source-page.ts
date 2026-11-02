import { HTMLElement, parse, type Node as HtmlNode } from "node-html-parser";
import type { CategoryNormalized } from "@ghc/shared-types";
import { canonicalizeUrl, filenameOf } from "./canonicalize";
import { parseDateRange, resolveListingDate } from "./dates";
import type { DiscoveredCauseListDocument, ParsedSourcePage } from "./types";

/**
 * Adapter `ghc_wp_table_v1` — based on the live page inspected 2026-11-02 (see docs/source-discovery.md):
 *  - server-rendered WordPress page, content in `.entry-content`
 *  - one `<table>`; first row = category headers (Daily | Supplementary | Lawazima | Notices);
 *    each later cell holds zero or more `<a href=".../NewCList/*.pdf">dd/mm/yyyy</a>` links, optionally
 *    followed by a free-text annotation such as "[Roster]" / "[Vacation Court]"
 *  - a standalone "Regular Hearing Causelist from dd.mm.yyyy to dd.mm.yyyy" link sits above the table
 */

/** Only labels actually observed on the source are mapped; anything else stays null (raw label kept). */
const COLUMN_LABEL_MAP: Record<string, CategoryNormalized> = {
  daily: "DAILY",
  supplementary: "SUPPLEMENTARY",
  lawazima: "LAWAZIMA",
  notices: "NOTICE",
  notice: "NOTICE",
};

export function normalizeCategoryLabel(label: string | null): CategoryNormalized | null {
  if (!label) return null;
  const key = label.trim().toLowerCase();
  if (COLUMN_LABEL_MAP[key]) return COLUMN_LABEL_MAP[key]!;
  if (/^regular\s+hearing\b/i.test(key)) return "REGULAR_HEARING";
  return null;
}

type Token = { kind: "a"; href: string; text: string } | { kind: "text"; text: string } | { kind: "br" };

function tokenize(node: HtmlNode, out: Token[]): void {
  if (node instanceof HTMLElement) {
    const tag = node.tagName?.toLowerCase();
    if (tag === "a") {
      out.push({ kind: "a", href: node.getAttribute("href") ?? "", text: node.text });
      return;
    }
    if (tag === "br") {
      out.push({ kind: "br" });
      return;
    }
    for (const child of node.childNodes) tokenize(child, out);
  } else {
    const text = node.text;
    if (text.trim()) out.push({ kind: "text", text });
  }
}

const clean = (s: string) => s.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
const stripBrackets = (s: string) => s.replace(/^[\s[(]+|[\s\])]+$/g, "").trim();

interface RawLink {
  canonicalUrl: string;
  sourceUrl: string;
  columnLabel: string | null;
  columnIndex: number | null;
  rowIndex: number | null;
  linkTexts: string[];
  annotations: string[];
}

export function parseSourcePage(html: string, pageUrl: string, sourceKey: string, discoveredAt: string): ParsedSourcePage {
  const root = parse(html);
  const warnings: string[] = [];
  const links = new Map<string, RawLink>();
  const columns: string[] = [];

  const upsert = (l: Omit<RawLink, "linkTexts" | "annotations"> & { linkText: string; annotation?: string }) => {
    const existing = links.get(l.canonicalUrl);
    if (existing) {
      if (l.linkText) existing.linkTexts.push(l.linkText);
      if (l.annotation) existing.annotations.push(l.annotation);
      return;
    }
    links.set(l.canonicalUrl, {
      canonicalUrl: l.canonicalUrl,
      sourceUrl: l.sourceUrl,
      columnLabel: l.columnLabel,
      columnIndex: l.columnIndex,
      rowIndex: l.rowIndex,
      linkTexts: l.linkText ? [l.linkText] : [],
      annotations: l.annotation ? [l.annotation] : [],
    });
  };

  const isCauseListHref = (href: string) => /\/NewCList\/[^/]+\.pdf$/i.test(href.split("?")[0] ?? "");

  // Locate the consolidated table: the table whose first row has >= 2 headers and that contains NewCList links.
  const tables = root.querySelectorAll("table");
  const table = tables.find((t) => t.querySelectorAll("a").some((a) => isCauseListHref(a.getAttribute("href") ?? "")));
  if (!table) warnings.push("No table containing cause-list PDF links was found; the page layout may have changed.");

  const tableAnchors = new Set(table ? table.querySelectorAll("a") : []);
  if (table) {
    const rows = table.querySelectorAll("tr");
    const headerCells = rows[0]?.querySelectorAll("th,td") ?? [];
    for (const c of headerCells) columns.push(clean(c.text));
    if (columns.filter(Boolean).length < 2) warnings.push("Table header row has fewer than 2 labelled columns.");
    rows.slice(1).forEach((row, ri) => {
      const cells = row.querySelectorAll("th,td");
      if (cells.length !== columns.length) warnings.push(`Row ${ri + 1} has ${cells.length} cells; expected ${columns.length}.`);
      cells.forEach((cell, ci) => {
        const tokens: Token[] = [];
        for (const child of cell.childNodes) tokenize(child, tokens);
        tokens.forEach((tok, ti) => {
          if (tok.kind !== "a" || !tok.href || !isCauseListHref(tok.href)) return;
          // Annotation = free text after this anchor up to the next anchor / line break.
          const notes: string[] = [];
          for (let j = ti + 1; j < tokens.length; j++) {
            const nx = tokens[j]!;
            if (nx.kind === "text") notes.push(nx.text);
            else break;
          }
          const annotation = clean(notes.join(" "));
          upsert({
            canonicalUrl: canonicalizeUrl(tok.href, pageUrl),
            sourceUrl: new URL(tok.href, pageUrl).toString(),
            columnLabel: columns[ci] || null,
            columnIndex: ci,
            rowIndex: ri,
            linkText: clean(tok.text),
            annotation: annotation || undefined,
          });
        });
      });
    });
  }

  // Stand-alone links outside the table (e.g. "Regular Hearing Causelist from … to …").
  for (const a of root.querySelectorAll("a")) {
    const href = a.getAttribute("href") ?? "";
    if (!isCauseListHref(href)) continue;
    if (tableAnchors.has(a)) continue;
    upsert({
      canonicalUrl: canonicalizeUrl(href, pageUrl),
      sourceUrl: new URL(href, pageUrl).toString(),
      columnLabel: null,
      columnIndex: null,
      rowIndex: null,
      linkText: clean(a.text),
    });
  }

  const documents: DiscoveredCauseListDocument[] = [];
  for (const l of links.values()) {
    const filename = filenameOf(l.canonicalUrl);
    const standalone = l.columnIndex === null;
    const joinedText = clean(l.linkTexts.join(" "));
    const annotationRaw = l.annotations.length ? [...new Set(l.annotations)].join(" ") : null;
    const publicationLabel = annotationRaw ? stripBrackets(annotationRaw) || null : null;

    let categoryLabelRaw = l.columnLabel;
    let categoryNormalized = normalizeCategoryLabel(categoryLabelRaw);
    const meta: Record<string, unknown> = {
      adapter: "ghc_wp_table_v1",
      link_texts: l.linkTexts,
      annotation_raw: annotationRaw,
      column_index: l.columnIndex,
      row_index: l.rowIndex,
      filename_prefix: filename ? (/^([A-Za-z]+)-/.exec(filename)?.[1] ?? null) : null,
    };

    let resolved = resolveListingDate(l.linkTexts, filename);
    let title: string | null;
    if (standalone) {
      // Free-standing link: the link text itself is the published label.
      categoryLabelRaw = joinedText || null;
      categoryNormalized = normalizeCategoryLabel(joinedText);
      const range = parseDateRange(joinedText);
      if (range) {
        meta.valid_from = range.from;
        meta.valid_to = range.to;
        resolved = { listingDate: null, status: "RANGE", raw: joinedText };
      } else {
        resolved = { listingDate: null, status: "UNPARSED", raw: joinedText || null };
      }
      title = joinedText || filename;
    } else {
      title = [categoryLabelRaw, joinedText, annotationRaw].filter(Boolean).join(" ").trim() || filename;
    }

    documents.push({
      sourceKey,
      title,
      categoryLabelRaw,
      categoryNormalized,
      listingDate: resolved.listingDate,
      listingDateRaw: resolved.raw,
      dateParseStatus: resolved.status,
      sourceUrl: l.sourceUrl,
      canonicalUrl: l.canonicalUrl,
      sourceFilename: filename,
      courtOrEstablishmentLabel: null,
      publicationLabel,
      discoveredAt,
      discoveryMetadata: meta,
    });
  }

  const unmapped = documents.filter((d) => d.categoryLabelRaw && !d.categoryNormalized);
  if (unmapped.length) {
    warnings.push(`${unmapped.length} document(s) have a category label with no verified mapping (raw label preserved).`);
  }
  return { documents, columns, warnings };
}
