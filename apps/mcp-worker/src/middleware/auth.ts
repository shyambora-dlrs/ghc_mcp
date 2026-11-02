import type { AppConfig } from "../env";
import { sha256Hex, timingSafeEqual } from "../utils/ids";

export function bearerOf(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : null;
}

function matchesAny(token: string | null, candidates: string[]): boolean {
  if (!token) return false;
  let ok = false;
  for (const c of candidates) if (c && timingSafeEqual(token, c)) ok = true; // no early exit: constant-ish time
  return ok;
}

export type McpAuth = { ok: true; principal: string } | { ok: false; status: number; message: string };

/** MCP clients authenticate with static bearer tokens (rotate via secrets). Production refuses to run without any. */
export async function authenticateMcp(req: Request, cfg: AppConfig): Promise<McpAuth> {
  const tokens = cfg.MCP_AUTH_TOKENS.split(",").map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) {
    if (cfg.APP_ENV === "production") return { ok: false, status: 503, message: "MCP authentication is not configured on this server." };
    return { ok: true, principal: "anonymous-dev" };
  }
  const token = bearerOf(req);
  if (!matchesAny(token, tokens)) return { ok: false, status: 401, message: "A valid bearer token is required." };
  return { ok: true, principal: `token:${(await sha256Hex(token!)).slice(0, 8)}` };
}

export function authenticateAdmin(req: Request, cfg: AppConfig): boolean {
  return cfg.ADMIN_API_TOKEN.length >= 16 && matchesAny(bearerOf(req), [cfg.ADMIN_API_TOKEN]);
}

export function authenticateParser(req: Request, cfg: AppConfig): boolean {
  return cfg.PARSER_CALLBACK_TOKEN.length >= 16 && matchesAny(bearerOf(req), [cfg.PARSER_CALLBACK_TOKEN]);
}
