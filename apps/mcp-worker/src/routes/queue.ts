import { ingestionMessageSchema } from "@ghc/shared-types";
import type { AppConfig, Env } from "../env";
import { downloadAndStore } from "../services/download.service";
import { dispatchParse, resetForRetry } from "../services/parse-dispatch.service";
import { AppError } from "../utils/errors";
import { errorFields, logEvent } from "../utils/log";

/** Queue consumer. Idempotent handlers + bounded retries (see wrangler.jsonc: max_retries and dead-letter queue). */
export async function handleQueue(batch: MessageBatch<unknown>, env: Env, cfg: AppConfig): Promise<void> {
  for (const msg of batch.messages) {
    const parsed = ingestionMessageSchema.safeParse(msg.body);
    if (!parsed.success) {
      logEvent("error", "queue.poison_message", { id: msg.id });
      msg.ack(); // invalid payloads can never succeed; drop rather than retry forever
      continue;
    }
    const m = parsed.data;
    try {
      switch (m.type) {
        case "DOWNLOAD_AND_STORE":
          await downloadAndStore(env, cfg, m.documentId, {}, m.force ?? false);
          break;
        case "PARSE_DOCUMENT_VERSION":
          await dispatchParse(env, cfg, m.documentVersionId);
          break;
        case "RETRY_DOCUMENT":
          await resetForRetry(env, m.documentVersionId);
          await dispatchParse(env, cfg, m.documentVersionId);
          break;
      }
      msg.ack();
    } catch (err) {
      logEvent("error", "queue.message_failed", { type: m.type, attempts: msg.attempts, ...errorFields(err) });
      const quick = err instanceof AppError ? (err.detail as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds : undefined;
      msg.retry({ delaySeconds: quick ?? Math.min(900, 30 * 2 ** Math.max(0, msg.attempts - 1)) });
    }
  }
}
