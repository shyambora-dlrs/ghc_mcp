/** Conservative date parsing. Anything ambiguous returns null — never guess from "today". */

function isRealDate(y: number, m: number, d: number): boolean {
  if (y < 1990 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const iso = (y: number, m: number, d: number) =>
  `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;

/**
 * Day-first dd/mm/yyyy (dd.mm.yyyy, dd-mm-yyyy also accepted). The Court publishes day-first dates
 * (verified: 27/10/2026 and 14/10/2026 appear in the source, which cannot be month-first).
 */
export function parseDayFirstDate(text: string | null | undefined, anchored = true): string | null {
  if (!text) return null;
  const t = text.trim();
  const re = anchored ? /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/ : /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/;
  const m = re.exec(t);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  return isRealDate(y, mo, d) ? iso(y, mo, d) : null;
}

/** Filenames look like `dl-03-11-2026.pdf` / `no-20-01-2025-SA.pdf`: prefix-dd-mm-yyyy[-suffix]. */
export function dateFromFilename(filename: string | null | undefined): string | null {
  if (!filename) return null;
  const m = /^[A-Za-z]+(?:-[A-Za-z]+)?-(\d{2})-(\d{2})-(\d{4})(?=[-_.]|$)/.exec(filename);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  return isRealDate(y, mo, d) ? iso(y, mo, d) : null;
}

export type DateParseStatus = "CONFIRMED" | "LINK_TEXT" | "FILENAME_ONLY" | "CONFLICT" | "UNPARSED" | "RANGE";

export interface ResolvedDate {
  listingDate: string | null;
  status: DateParseStatus;
  raw: string | null;
}

/**
 * Link text is the published label; the filename date is a secondary signal. They must agree
 * for CONFIRMED. A disagreement stores NO normalized date (status CONFLICT) so it is never guessed.
 */
export function resolveListingDate(linkTexts: string[], filename: string | null): ResolvedDate {
  const raw = linkTexts.map((t) => t.trim()).filter(Boolean).join(" ") || null;
  const candidates = [...linkTexts.map((t) => parseDayFirstDate(t)), parseDayFirstDate(linkTexts.join(""))];
  const fromText = candidates.find((c) => c !== null) ?? null;
  const fromName = dateFromFilename(filename);
  if (fromText && fromName) {
    return fromText === fromName
      ? { listingDate: fromText, status: "CONFIRMED", raw }
      : { listingDate: null, status: "CONFLICT", raw };
  }
  if (fromText) return { listingDate: fromText, status: "LINK_TEXT", raw };
  if (fromName) return { listingDate: fromName, status: "FILENAME_ONLY", raw };
  return { listingDate: null, status: "UNPARSED", raw };
}

/** "from 02.11.2026 to 23.12.2026" -> { from, to } (both must parse). */
export function parseDateRange(text: string): { from: string; to: string } | null {
  const m = /from\s+(\d{1,2}[./-]\d{1,2}[./-]\d{4})\s+to\s+(\d{1,2}[./-]\d{1,2}[./-]\d{4})/i.exec(text);
  if (!m) return null;
  const from = parseDayFirstDate(m[1]);
  const to = parseDayFirstDate(m[2]);
  return from && to ? { from, to } : null;
}
