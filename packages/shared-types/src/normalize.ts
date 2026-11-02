/**
 * Search-normalization helpers. Normalized values are used ONLY for lookup; the raw source
 * spelling is always stored and returned. The Python parser mirrors these functions and both
 * are tested against packages/shared-types/test-vectors/normalization.json.
 */

export interface NormalizedCaseNumber {
  /** e.g. "WP(C)/1589/2026" — uppercase, whitespace removed, number without leading zeros. */
  normalized: string;
  /** Punctuation-insensitive lookup key, e.g. "WPC15892026". */
  key: string;
  caseType: string;
  caseNumber: number;
  caseYear: number;
  /** false when the year is outside a generous plausibility window (kept, but flagged). */
  yearPlausible: boolean;
}

// TYPE (letters, digits, dots, parens, ampersand, spaces) / NUMBER / YEAR. Separators: "/" or whitespace.
const CASE_RE = /^([A-Za-z][A-Za-z0-9.()&]*(?:\s+[A-Za-z0-9.()&]+)*?)\s*[/\s]\s*(\d{1,7})\s*[/\s]\s*(\d{4})$/;

/** Returns null when the text is not confidently a "TYPE/NUMBER/YEAR" case number. */
export function normalizeCaseNumber(input: string | null | undefined): NormalizedCaseNumber | null {
  if (!input) return null;
  const text = input.normalize("NFKC").replace(/[‐-―]/g, "-").trim().replace(/\s+/g, " ");
  const m = CASE_RE.exec(text);
  if (!m) return null;
  const caseType = m[1]!.replace(/\s+/g, "").toUpperCase();
  const caseNumber = Number.parseInt(m[2]!, 10);
  const caseYear = Number.parseInt(m[3]!, 10);
  if (!Number.isFinite(caseNumber) || caseNumber <= 0) return null;
  const key = `${caseType.replace(/[^A-Z0-9]/g, "")}${caseNumber}${caseYear}`;
  return {
    normalized: `${caseType}/${caseNumber}/${caseYear}`,
    key,
    caseType,
    caseNumber,
    caseYear,
    yearPlausible: caseYear >= 1900 && caseYear <= 2100,
  };
}

/** Lookup-only normalization for party / advocate / court text. Does not strip titles or merge names. */
export function normalizeName(input: string | null | undefined): string | null {
  if (!input) return null;
  const out = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  return out.length > 0 ? out : null;
}

/** Extract a bare court number from labels like "COURT NO: 115" / "Court No. 3". */
export function normalizeCourtNumber(input: string | null | undefined): string | null {
  if (!input) return null;
  const m = /COURT\s*(?:NO\.?|NUMBER)?\s*[:.\-]?\s*([A-Za-z0-9]+)/i.exec(input);
  return m ? m[1]!.toUpperCase() : null;
}
