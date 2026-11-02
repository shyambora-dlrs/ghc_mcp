import { AppError } from "../utils/errors";

/**
 * Canonical form used as the document identity. Host is lowercased, fragment and default port are
 * dropped, but the path and query are preserved verbatim (query parameters may be meaningful).
 */
export function canonicalizeUrl(href: string, base?: string): string {
  const u = new URL(href.trim(), base);
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
  return u.toString();
}

/** SSRF guard: only https, no credentials, no non-default port, and only allowlisted official hosts. */
export function assertAllowedUrl(url: string, allowedHosts: string[]): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new AppError("INVALID_INPUT", "Invalid URL.", 400);
  }
  if (u.protocol !== "https:") throw new AppError("FORBIDDEN", "Only https URLs are allowed.", 403);
  if (u.username || u.password) throw new AppError("FORBIDDEN", "URLs with credentials are not allowed.", 403);
  if (u.port && u.port !== "443") throw new AppError("FORBIDDEN", "Non-default ports are not allowed.", 403);
  if (!allowedHosts.includes(u.hostname.toLowerCase())) {
    throw new AppError("FORBIDDEN", `Host ${u.hostname} is not on the crawler allowlist.`, 403);
  }
  return u;
}

export function filenameOf(url: string): string | null {
  const last = new URL(url).pathname.split("/").filter(Boolean).pop();
  if (!last) return null;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}
