import { z } from "zod";
import type { AppConfig } from "../env";
import { AppError } from "../utils/errors";
import { errorFields, logEvent } from "../utils/log";

export type LlmErrorKind =
  | "disabled" | "not_configured" | "auth" | "invalid_model" | "rate_limit" | "timeout" | "server" | "bad_response" | "network" | "input_too_large";

/** Classified, safe-to-display error. The upstream body is never included. */
export class LlmError extends Error {
  constructor(readonly kind: LlmErrorKind, message: string, readonly retryable = false) {
    super(message);
    this.name = "LlmError";
  }
}

export interface LlmProvider {
  complete(input: { systemPrompt: string; userPrompt: string }): Promise<{ text: string; model: string }>;
}

export interface GroqConfig {
  apiKey: string; baseUrl: string; model: string; enabled: boolean;
  timeoutMs: number; maxCompletionTokens: number; temperature: number; maxInputChars: number;
}

export const groqConfigFrom = (c: AppConfig): GroqConfig => ({
  apiKey: c.GROQ_API_KEY, baseUrl: c.GROQ_BASE_URL, model: c.GROQ_MODEL, enabled: c.GROQ_ENABLED,
  timeoutMs: c.GROQ_TIMEOUT_MS, maxCompletionTokens: c.GROQ_MAX_COMPLETION_TOKENS, temperature: c.GROQ_TEMPERATURE, maxInputChars: c.GROQ_MAX_INPUT_CHARS,
});

const responseSchema = z.object({
  model: z.string().optional(),
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable().optional() }).optional() })).min(1),
});

export interface GroqDeps { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> }
const MAX_ATTEMPTS = 3;

function classify(status: number, bodyText: string): LlmError {
  if (status === 401 || status === 403) return new LlmError("auth", "The AI provider rejected the configured credentials.");
  if (status === 404 || (status === 400 && /model/i.test(bodyText))) return new LlmError("invalid_model", "The configured AI model is not available for this account.");
  if (status === 429) return new LlmError("rate_limit", "The AI provider is rate limiting requests.", true);
  if (status >= 500) return new LlmError("server", "The AI provider had a server error.", true);
  return new LlmError("bad_response", `The AI provider rejected the request (HTTP ${status}).`);
}

/**
 * Server-side Groq Chat Completions call (OpenAI-compatible). Retries only transient failures
 * (timeout, 429, 5xx, network); never retries auth or invalid-model errors. The API key, prompts and
 * upstream error bodies are never logged or returned.
 */
export async function createGroundedCompletion(
  config: GroqConfig,
  input: { systemPrompt: string; userPrompt: string },
  deps: GroqDeps = {},
): Promise<{ text: string; model: string }> {
  if (!config.enabled) throw new LlmError("disabled", "AI summaries are disabled on this server.");
  if (!config.apiKey || !config.model) throw new LlmError("not_configured", "AI summaries are not configured on this server.");
  if (input.systemPrompt.length + input.userPrompt.length > config.maxInputChars + 4000) {
    throw new LlmError("input_too_large", "The context is too large to send to the AI provider.");
  }
  const doFetch = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let last: LlmError = new LlmError("network", "The AI provider could not be reached.", true);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), config.timeoutMs);
    try {
      const res = await doFetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: "system", content: input.systemPrompt }, { role: "user", content: input.userPrompt }],
          temperature: config.temperature,
          max_tokens: config.maxCompletionTokens,
        }),
        signal: ctl.signal,
      });
      if (!res.ok) {
        const text = (await res.text().catch(() => "")).slice(0, 300);
        last = classify(res.status, text);
        logEvent("warn", "groq.request_failed", { status: res.status, kind: last.kind, attempt: attempt + 1 });
        if (!last.retryable) throw last;
        continue;
      }
      const parsed = responseSchema.safeParse(await res.json().catch(() => null));
      const content = parsed.success ? parsed.data.choices[0]?.message?.content?.trim() : undefined;
      if (!parsed.success || !content) throw new LlmError("bad_response", "The AI provider returned an unexpected response.");
      logEvent("info", "groq.request_succeeded", { model: parsed.data.model ?? config.model, attempt: attempt + 1 });
      return { text: content, model: parsed.data.model ?? config.model };
    } catch (err) {
      if (err instanceof LlmError) {
        if (!err.retryable) throw err;
        last = err;
        continue;
      }
      const aborted = err instanceof Error && err.name === "AbortError";
      last = new LlmError(aborted ? "timeout" : "network", aborted ? "The AI provider timed out." : "The AI provider could not be reached.", true);
      logEvent("warn", aborted ? "groq.request_timeout" : "groq.network_error", { attempt: attempt + 1, ...errorFields(err) });
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}

export class GroqProvider implements LlmProvider {
  constructor(private readonly config: GroqConfig, private readonly deps: GroqDeps = {}) {}
  complete(input: { systemPrompt: string; userPrompt: string }) {
    return createGroundedCompletion(this.config, input, this.deps);
  }
}

export function toAppError(err: LlmError): AppError {
  const status = err.kind === "rate_limit" ? 429 : err.kind === "disabled" || err.kind === "not_configured" ? 503 : 502;
  return new AppError(err.kind === "rate_limit" ? "RATE_LIMITED" : "UNAVAILABLE", err.message, status);
}
