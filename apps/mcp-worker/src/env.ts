import { z } from "zod";
import type { IngestionMessage } from "@ghc/shared-types";

export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Cloudflare bindings + vars + secrets. Secrets are only ever read here, server-side. */
export interface Env {
  DB: D1Database;
  DOCUMENTS_BUCKET: R2Bucket;
  INGESTION_QUEUE: Queue<IngestionMessage>;
  /** Optional Workers Rate Limiting bindings; an in-isolate fallback is used when absent. */
  MCP_RATE_LIMITER?: RateLimitBinding;
  AI_RATE_LIMITER?: RateLimitBinding;

  [key: string]: unknown;
}

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.trim().toLowerCase())));
const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def);

const configSchema = z.object({
  APP_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  APP_BASE_URL: z.string().default("http://localhost:8787"),
  LOG_LEVEL: z.string().default("info"),

  GHC_SOURCE_URL: z.string().url().default("https://ghconline.gov.in/index.php/consolidated-cause-list/"),
  CRAWLER_USER_AGENT: z.string().default("GHC-Cause-List-MCP/1.0 (contact: configure-a-contact-address)"),
  CRAWLER_MIN_INTERVAL_MS: int(3000, 0, 60000),
  CRAWLER_TIMEOUT_MS: int(30000, 1000, 120000),
  CRAWLER_MAX_DOWNLOAD_BYTES: int(52_428_800, 1024),
  CRAWLER_ALLOWED_HOSTS: z.string().default("ghconline.gov.in,www.ghconline.gov.in"),
  /** Only documents with a listing date this recent are queued for download (older ones stay DISCOVERED). */
  CRAWL_LOOKBACK_DAYS: int(14, 0, 3650),
  /** Already-downloaded documents this recent are re-checked with conditional requests for revisions. */
  RECHECK_DAYS: int(3, 0, 365),
  MAX_DOWNLOADS_PER_CRAWL: int(60, 1, 5000),
  MAX_PDF_PAGES: int(1500, 1, 20000),

  MCP_AUTH_TOKENS: z.string().default(""),
  ADMIN_API_TOKEN: z.string().default(""),
  PARSER_CALLBACK_TOKEN: z.string().default(""),
  INGESTION_SERVICE_URL: z.string().default(""),
  INGESTION_SERVICE_TOKEN: z.string().default(""),
  DOWNLOAD_SIGNING_SECRET: z.string().default(""),
  DOWNLOAD_LINK_TTL_SECONDS: int(300, 30, 3600),
  MCP_RATE_LIMIT_PER_MINUTE: int(120, 1, 100000),
  AI_RATE_LIMIT_PER_MINUTE: int(10, 1, 100000),
  STALE_AFTER_HOURS: int(36, 1, 24 * 30),

  GROQ_API_KEY: z.string().default(""),
  GROQ_BASE_URL: z.string().default("https://api.groq.com/openai/v1"),
  GROQ_MODEL: z.string().default(""),
  GROQ_ENABLED: bool.default(false),
  GROQ_TIMEOUT_MS: int(30000, 1000, 120000),
  GROQ_MAX_COMPLETION_TOKENS: int(1200, 16, 8192),
  GROQ_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  GROQ_MAX_INPUT_CHARS: int(24000, 500, 200000),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: Env): AppConfig {
  const raw: Record<string, unknown> = {};
  for (const key of Object.keys(configSchema.shape)) {
    const v = env[key];
    if (typeof v === "string" || typeof v === "boolean" || typeof v === "number") raw[key] = v;
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${msg}`);
  }
  return parsed.data;
}

export const SOURCE_KEY = "ghc_consolidated_cause_list";
export const SOURCE_NAME = "Gauhati High Court Consolidated Cause List";
