import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import type { AppConfig, Env } from "../../env";
import type { RateLimiter } from "../../middleware/ratelimit";
import type { LlmProvider } from "../../services/groq.service";
import { AppError, toPublicError } from "../../utils/errors";
import { errorFields, logEvent } from "../../utils/log";

export interface ToolContext {
  env: Env;
  cfg: AppConfig;
  llm: LlmProvider;
  principal: string;
  rateLimiter: RateLimiter;
  aiRateLimiter: RateLimiter;
}

export interface ToolOutput {
  /** Short human-readable summary shown above the JSON in text-only clients. */
  summary: string;
  data: Record<string, unknown>;
}

const MAX_TEXT = 60_000;

export function defineTool<I extends ZodRawShape, O extends ZodRawShape>(
  server: McpServer,
  ctx: ToolContext,
  name: string,
  def: { title: string; description: string; input: I; output: O; ai?: boolean },
  handler: (args: z.infer<z.ZodObject<I>>) => Promise<ToolOutput>,
): void {
  server.registerTool(
    name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.input,
      // Loose: declared keys are typed and required, but additional informational keys are allowed (clients validate
      // structuredContent against this schema, so a strict object would reject any extra field).
      outputSchema: z.looseObject(def.output),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (async (args: z.infer<z.ZodObject<I>>): Promise<CallToolResult> => {
      const t0 = Date.now();
      try {
        const limiter = def.ai ? ctx.aiRateLimiter : ctx.rateLimiter;
        if (!(await limiter.allow(`${ctx.principal}:${def.ai ? "ai" : "tool"}`))) {
          throw new AppError("RATE_LIMITED", "Rate limit exceeded. Please wait a minute and retry.", 429);
        }
        const out = await handler(args);
        const json = JSON.stringify(out.data, null, 1);
        logEvent("info", "mcp.tool_completed", { tool: name, principal: ctx.principal, elapsed_ms: Date.now() - t0 });
        return {
          content: [{ type: "text", text: `${out.summary}\n\n${json.length > MAX_TEXT ? `${json.slice(0, MAX_TEXT)}\n…[truncated; use structuredContent or paginate]` : json}` }],
          structuredContent: out.data,
        };
      } catch (err) {
        const pub = toPublicError(err);
        // Public clients get a safe message; detail stays in protected logs.
        logEvent(pub.code === "INTERNAL" ? "error" : "warn", "mcp.tool_failed", { tool: name, principal: ctx.principal, code: pub.code, ...(pub.code === "INTERNAL" ? errorFields(err) : {}) });
        return { isError: true, content: [{ type: "text", text: `${pub.code}: ${pub.message}` }] };
      }
    }) as never,
  );
}
