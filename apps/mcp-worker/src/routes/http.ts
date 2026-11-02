import { toPublicError } from "../utils/errors";

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

export function errorResponse(err: unknown): Response {
  const p = toPublicError(err);
  return json({ success: false, error: { code: p.code, message: p.message } }, p.status);
}

/** Reads a JSON body with a hard size cap (default 8 MB) so oversized callbacks are rejected early. */
export async function readJson(req: Request, maxBytes = 8_000_000): Promise<unknown> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw Object.assign(new Error("too large"), { tooLarge: true });
  const text = await req.text();
  if (text.length > maxBytes) throw Object.assign(new Error("too large"), { tooLarge: true });
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
