import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertAllowedUrl, canonicalizeUrl, filenameOf } from "../src/crawler/canonicalize";
import { dateFromFilename, parseDateRange, parseDayFirstDate, resolveListingDate } from "../src/crawler/dates";
import { normalizeCategoryLabel, parseSourcePage } from "../src/crawler/parse-source-page";

const html = readFileSync(join(import.meta.dirname, "../../../tests/fixtures/source/consolidated-cause-list.trimmed.html"), "utf8");
const PAGE = "https://ghconline.gov.in/index.php/consolidated-cause-list/";
const parsed = parseSourcePage(html, PAGE, "ghc_consolidated_cause_list", "2026-11-02T00:00:00Z");
const byFile = (f: string) => parsed.documents.find((d) => d.sourceFilename === f);

describe("URL handling", () => {
  it("canonicalizes without dropping query parameters", () => {
    expect(canonicalizeUrl("HTTPS://GHConline.gov.in:443/NewCList/dl-03-11-2026.pdf#x")).toBe("https://ghconline.gov.in/NewCList/dl-03-11-2026.pdf");
    expect(canonicalizeUrl("/a.pdf?id=5", "https://ghconline.gov.in/x/")).toBe("https://ghconline.gov.in/a.pdf?id=5");
  });
  it("extracts filenames", () => expect(filenameOf("https://ghconline.gov.in/NewCList/no-02-11-2026-1.pdf")).toBe("no-02-11-2026-1.pdf"));
  it("enforces the SSRF allowlist", () => {
    const hosts = ["ghconline.gov.in"];
    expect(() => assertAllowedUrl("https://ghconline.gov.in/x.pdf", hosts)).not.toThrow();
    for (const bad of ["http://ghconline.gov.in/x.pdf", "https://evil.example/x.pdf", "https://ghconline.gov.in:8443/x", "https://user:pw@ghconline.gov.in/x", "https://ghconline.gov.in.evil.example/x", "file:///etc/passwd", "https://127.0.0.1/x"]) {
      expect(() => assertAllowedUrl(bad, hosts), bad).toThrow();
    }
  });
});

describe("date parsing is conservative", () => {
  it("parses day-first and rejects impossible dates", () => {
    expect(parseDayFirstDate("03/11/2026")).toBe("2026-11-03");
    expect(parseDayFirstDate("27/10/2026")).toBe("2026-10-27");
    expect(parseDayFirstDate("31/02/2026")).toBeNull();
    expect(parseDayFirstDate("13/13/2026")).toBeNull();
    expect(parseDayFirstDate("/01/2025")).toBeNull();
    expect(parseDayFirstDate("")).toBeNull();
  });
  it("parses filename dates", () => {
    expect(dateFromFilename("dl-03-11-2026.pdf")).toBe("2026-11-03");
    expect(dateFromFilename("no-20-01-2025-SA.pdf")).toBe("2025-01-20");
    expect(dateFromFilename("LA-Sl-14-03-2026.pdf")).toBe("2026-03-14");
    expect(dateFromFilename("CategoryCodes.pdf")).toBeNull();
  });
  it("reports CONFLICT instead of guessing", () => {
    expect(resolveListingDate(["03/11/2026"], "dl-04-11-2026.pdf")).toMatchObject({ listingDate: null, status: "CONFLICT" });
    expect(resolveListingDate(["03/11/2026"], "dl-03-11-2026.pdf")).toMatchObject({ listingDate: "2026-11-03", status: "CONFIRMED" });
    expect(resolveListingDate([], "zzz")).toMatchObject({ listingDate: null, status: "UNPARSED" });
  });
  it("parses ranges", () => expect(parseDateRange("Regular Hearing Causelist from 02.11.2026 to 23.12.2026")).toEqual({ from: "2026-11-02", to: "2026-12-23" }));
});

describe("source page parser (fixture of the live page captured 2026-11-02)", () => {
  it("finds the four published columns", () => expect(parsed.columns).toEqual(["Daily", "Supplementary", "Lawazima", "Notices"]));
  it("maps only observed category labels", () => {
    expect(normalizeCategoryLabel("Daily")).toBe("DAILY");
    expect(normalizeCategoryLabel("Notices")).toBe("NOTICE");
    expect(normalizeCategoryLabel("Something New")).toBeNull();
  });
  it("discovers documents by column with raw labels preserved", () => {
    const d = byFile("dl-03-11-2026.pdf")!;
    expect(d).toMatchObject({ categoryLabelRaw: "Daily", categoryNormalized: "DAILY", listingDate: "2026-11-03", dateParseStatus: "CONFIRMED" });
    expect(d.canonicalUrl).toBe("https://ghconline.gov.in/NewCList/dl-03-11-2026.pdf");
    expect(byFile("sl-02-11-2026.pdf")).toMatchObject({ categoryNormalized: "SUPPLEMENTARY" });
    expect(byFile("lz-02-11-2026.pdf")).toMatchObject({ categoryNormalized: "LAWAZIMA" });
  });
  it("captures annotations such as [Roster] and [Vacation Court]", () => {
    expect(byFile("no-02-11-2026.pdf")).toMatchObject({ categoryNormalized: "NOTICE", publicationLabel: "Roster" });
    expect(byFile("no-02-11-2026-1.pdf")?.publicationLabel).toBe("Sitting Arrangement");
    expect(byFile("vc-27-10-2026.pdf")).toMatchObject({ categoryNormalized: "DAILY", publicationLabel: "Vacation Court" });
  });
  it("treats the stand-alone Regular Hearing link as a date-range document with no single listing date", () => {
    const d = byFile("hl-02-11-2026.pdf")!;
    expect(d).toMatchObject({ categoryNormalized: "REGULAR_HEARING", listingDate: null, dateParseStatus: "RANGE" });
    expect(d.discoveryMetadata).toMatchObject({ valid_from: "2026-11-02", valid_to: "2026-12-23" });
  });
  it("handles malformed link text by cross-checking the filename", () => {
    const d = byFile("no-24-01-2025.pdf");
    expect(d?.listingDate === null || d?.listingDate === "2025-01-24").toBe(true);
  });
  it("never creates documents for non cause-list links and de-duplicates by canonical URL", () => {
    expect(parsed.documents.every((d) => d.canonicalUrl.includes("/NewCList/"))).toBe(true);
    expect(new Set(parsed.documents.map((d) => d.canonicalUrl)).size).toBe(parsed.documents.length);
  });
  it("preserves odd legacy prefixes without inventing categories for them", () => {
    expect(byFile("LA-14-03-2026.pdf")).toBeTruthy();
    expect(byFile("Cl-04-04-2026.pdf")?.categoryLabelRaw).toBe("Daily");
  });
  it("warns when the layout is unrecognised", () => {
    const p = parseSourcePage("<html><body><p>nothing</p></body></html>", PAGE, "k", "t");
    expect(p.documents).toHaveLength(0);
    expect(p.warnings.length).toBeGreaterThan(0);
  });
});
