import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { loadConfig, type Env } from "../env";
import { authenticateMcp } from "../middleware/auth";
import { limiterFor } from "../middleware/ratelimit";
import { GroqProvider, groqConfigFrom, type LlmProvider } from "../services/groq.service";
import { logEvent } from "../utils/log";
import { registerResources } from "./resources";
import { registerTools } from "./tools";
import type { ToolContext } from "./tools/define";

export const SERVER_INFO = { name: "ghc-cause-list-mcp", version: "1.0.0" } as const;

export const SERVER_INSTRUCTIONS =
  "Read-only access to publicly published Gauhati High Court consolidated cause lists. Results are extracted from official PDFs and always cite the document, version hash and PDF page; the official PDF is the source of truth. " +
  "A cause-list entry is not proof that a matter was heard, disposed of or ordered. Use search_case for exact case numbers; AI tools (summarize_cause_list, explain_cause_list_terms) are optional and never authoritative.";

export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server, ctx);
  registerResources(server, ctx);
  return server;
}

/**
 * Stateless Streamable HTTP endpoint: a fresh server + transport per request (no session affinity
 * needed on Workers). JSON responses are enabled so simple clients need no SSE handling.
 */
export async function handleMcpRequest(req: Request, env: Env, llmOverride?: LlmProvider): Promise<Response> {
  const cfg = loadConfig(env);
  const auth = await authenticateMcp(req, cfg);
  if (!auth.ok) {
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: auth.message }, id: null }), {
      status: auth.status, headers: { "content-type": "application/json", ...(auth.status === 401 ? { "www-authenticate": 'Bearer realm="ghc-cause-list-mcp"' } : {}) },
    });
  }
  const clientKey = auth.principal === "anonymous-dev" ? (req.headers.get("cf-connecting-ip") ?? "local") : auth.principal;
  const rateLimiter = limiterFor("mcp", cfg.MCP_RATE_LIMIT_PER_MINUTE, env.MCP_RATE_LIMITER);
  if (!(await rateLimiter.allow(`edge:${clientKey}`))) {
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32002, message: "Rate limit exceeded." }, id: null }), { status: 429, headers: { "content-type": "application/json", "retry-after": "60" } });
  }
  const ctx: ToolContext = {
    env, cfg, principal: clientKey,
    llm: llmOverride ?? new GroqProvider(groqConfigFrom(cfg)),
    rateLimiter, aiRateLimiter: limiterFor("ai", cfg.AI_RATE_LIMIT_PER_MINUTE, env.AI_RATE_LIMITER),
  };
  const server = createMcpServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } catch (err) {
    logEvent("error", "mcp.transport_error", { message: err instanceof Error ? err.message : "unknown" });
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }), { status: 500, headers: { "content-type": "application/json" } });
  }
}
