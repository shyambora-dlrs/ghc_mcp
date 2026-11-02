import type { SourceConfig } from "../config/source";
import { AppError } from "../utils/errors";
import { logEvent } from "../utils/log";
import { assertAllowedUrl } from "./canonicalize";

export interface FetchOptions {
  accept?: string;
  ifNoneMatch?: string | null;
  ifModifiedSince?: string | null;
  maxBytes?: number;
}

export interface FetchResult {
  status: number;
  finalUrl: string;
  headers: Headers;
  body: Uint8Array | null;
  notModified: boolean;
}

export interface FetcherDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

const MAX_REDIRECTS = 5;
const MAX_ATTEMPTS = 3;

/**
 * Sequential, rate-limited fetcher for the official host: allowlisted hosts only (redirects are
 * re-validated), minimum interval between requests, exponential backoff with jitter on transient
 * failures, conditional requests, and a hard byte cap. Never used for user-supplied URLs.
 */
export class PoliteFetcher {
  private lastRequestAt = 0;
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(
    private readonly cfg: SourceConfig,
    deps: FetcherDeps = {},
  ) {
    this.doFetch = deps.fetch ?? ((...a) => fetch(...a));
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + this.cfg.minimumRequestIntervalMs - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
  }

  async get(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const backoff = 1000 * 2 ** (attempt - 1);
        await this.sleep(backoff + Math.floor(this.random() * 500));
      }
      try {
        const res = await this.once(url, opts);
        if (res.status === 429 || res.status >= 500) {
          lastErr = new AppError("UPSTREAM_ERROR", `Source returned HTTP ${res.status}.`, 502);
          const ra = Number(res.headers.get("retry-after"));
          if (Number.isFinite(ra) && ra > 0) await this.sleep(Math.min(ra, 10) * 1000);
          continue;
        }
        return res;
      } catch (err) {
        if (err instanceof AppError && err.code !== "UPSTREAM_ERROR") throw err; // policy errors are not transient
        lastErr = err;
        logEvent("warn", "crawler.fetch_retry", { attempt: attempt + 1, url });
      }
    }
    throw lastErr instanceof AppError ? lastErr : new AppError("UPSTREAM_ERROR", "The source could not be reached.", 502, lastErr);
  }

  private async once(startUrl: string, opts: FetchOptions): Promise<FetchResult> {
    let url = startUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      assertAllowedUrl(url, this.cfg.allowedHosts);
      await this.throttle();
      const headers: Record<string, string> = {
        "User-Agent": this.cfg.userAgent,
        Accept: opts.accept ?? "*/*",
      };
      if (opts.ifNoneMatch) headers["If-None-Match"] = opts.ifNoneMatch;
      if (opts.ifModifiedSince) headers["If-Modified-Since"] = opts.ifModifiedSince;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.cfg.requestTimeoutMs);
      try {
        const res = await this.doFetch(url, { headers, redirect: "manual", signal: ctl.signal });
        if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
          url = new URL(res.headers.get("location")!, url).toString();
          await res.body?.cancel();
          continue;
        }
        if (res.status === 304) {
          await res.body?.cancel();
          return { status: 304, finalUrl: url, headers: res.headers, body: null, notModified: true };
        }
        if (!res.ok) {
          await res.body?.cancel();
          return { status: res.status, finalUrl: url, headers: res.headers, body: null, notModified: false };
        }
        const max = opts.maxBytes ?? this.cfg.maxDownloadBytes;
        const declared = Number(res.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > max) {
          await res.body?.cancel();
          throw new AppError("INVALID_INPUT", `Response is ${declared} bytes; limit is ${max}.`, 413);
        }
        const body = await readCapped(res, max);
        return { status: res.status, finalUrl: url, headers: res.headers, body, notModified: false };
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw new AppError("UPSTREAM_ERROR", "Network error while contacting the source.", 502, err);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new AppError("UPSTREAM_ERROR", "Too many redirects.", 502);
  }
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new AppError("INVALID_INPUT", `Response exceeded the ${max} byte limit.`, 413);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
