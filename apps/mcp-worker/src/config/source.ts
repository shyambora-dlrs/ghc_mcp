import type { AppConfig } from "../env";
import { SOURCE_KEY, SOURCE_NAME } from "../env";

/** Typed source configuration. The URL comes from config (GHC_SOURCE_URL), never from scattered literals. */
export interface SourceConfig {
  sourceKey: string;
  sourceName: string;
  sourcePageUrl: string;
  enabled: boolean;
  crawlerAdapter: string;
  requestTimeoutMs: number;
  minimumRequestIntervalMs: number;
  maxDownloadBytes: number;
  allowedHosts: string[];
  userAgent: string;
}

export function sourceConfigFrom(cfg: AppConfig): SourceConfig {
  return {
    sourceKey: SOURCE_KEY,
    sourceName: SOURCE_NAME,
    sourcePageUrl: cfg.GHC_SOURCE_URL,
    enabled: true,
    crawlerAdapter: "ghc_wp_table_v1",
    requestTimeoutMs: cfg.CRAWLER_TIMEOUT_MS,
    minimumRequestIntervalMs: cfg.CRAWLER_MIN_INTERVAL_MS,
    maxDownloadBytes: cfg.CRAWLER_MAX_DOWNLOAD_BYTES,
    allowedHosts: cfg.CRAWLER_ALLOWED_HOSTS.split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    userAgent: cfg.CRAWLER_USER_AGENT,
  };
}
