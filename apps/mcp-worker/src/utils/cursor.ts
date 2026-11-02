import { invalid } from "./errors";

/** Opaque offset cursor. Offsets are bounded so a forged cursor cannot force an expensive scan. */
export function encodeCursor(offset: number): string {
  return btoa(JSON.stringify({ o: offset })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  try {
    const json = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    const o = (JSON.parse(json) as { o?: unknown }).o;
    if (typeof o === "number" && Number.isInteger(o) && o >= 0 && o <= 100_000) return o;
  } catch {
    /* fall through */
  }
  throw invalid("The pagination cursor is invalid. Re-run the query without a cursor.");
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  next_cursor: string | null;
}

export function pageOf<T>(items: T[], total: number, offset: number, limit: number): Page<T> {
  const next = offset + items.length;
  return { items, total, limit, next_cursor: next < total ? encodeCursor(next) : null };
}
