/** Thin helpers over D1. Every statement in the codebase uses bound parameters — never string interpolation of values. */

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** D1 allows at most 100 bound parameters per statement; keep IN-lists well under it. */
export const IN_CHUNK = 80;

export const placeholders = (n: number): string => Array.from({ length: n }, () => "?").join(",");

export async function all<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const res = await db.prepare(sql).bind(...params).all<T>();
  return res.results ?? [];
}

export async function first<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return (await db.prepare(sql).bind(...params).first<T>()) ?? null;
}

export async function run(db: D1Database, sql: string, ...params: unknown[]): Promise<D1Result> {
  return db.prepare(sql).bind(...params).run();
}

/** Runs statements in batches (each batch is atomic in D1). */
export async function batchRun(db: D1Database, stmts: D1PreparedStatement[], size = 50): Promise<void> {
  for (const part of chunk(stmts, size)) await db.batch(part);
}

/** Escape LIKE wildcards in user text (use with `ESCAPE '\\'`). */
export const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);
