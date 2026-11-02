import type { RateLimitBinding } from "../env";

export interface RateLimiter {
  allow(key: string): Promise<boolean>;
}

/**
 * Best-effort per-isolate sliding window. Isolates are not shared globally, so production should
 * bind Cloudflare's Rate Limiting API (MCP_RATE_LIMITER / AI_RATE_LIMITER) — see docs/deployment.md.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly perMinute: number, private readonly now: () => number = Date.now) {}
  async allow(key: string): Promise<boolean> {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < 60_000);
    if (recent.length >= this.perMinute) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (!v.some((x) => t - x < 60_000)) this.hits.delete(k);
    return true;
  }
}

export class BindingRateLimiter implements RateLimiter {
  constructor(private readonly binding: RateLimitBinding) {}
  async allow(key: string): Promise<boolean> {
    return (await this.binding.limit({ key })).success;
  }
}

const shared = new Map<string, InMemoryRateLimiter>();
export function limiterFor(name: string, perMinute: number, binding?: RateLimitBinding): RateLimiter {
  if (binding) return new BindingRateLimiter(binding);
  const k = `${name}:${perMinute}`;
  return shared.get(k) ?? shared.set(k, new InMemoryRateLimiter(perMinute)).get(k)!;
}
