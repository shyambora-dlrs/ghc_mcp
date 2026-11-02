/* eslint-disable no-console -- the structured logger is the single sanctioned console user */
export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /authorization|token|api[-_]?key|secret|password|cookie/i;

let threshold: LogLevel = "info";
export function setLogLevel(level: string | undefined): void {
  if (level === "debug" || level === "info" || level === "warn" || level === "error") threshold = level;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 500)}…[${value.length} chars]` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Structured event logging. Never pass full case text or credentials; keys that look secret are redacted. */
export function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  if (ORDER[level] < ORDER[threshold]) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...(redact(fields) as object) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const errorFields = (err: unknown): Record<string, unknown> => ({
  error_name: err instanceof Error ? err.name : typeof err,
  error_message: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
});
