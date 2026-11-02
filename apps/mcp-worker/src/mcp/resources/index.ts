import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { first } from "../../repositories/db";
import { getDocumentDetails, getDocumentPage } from "../../services/document.service";
import { listDocuments } from "../../services/search.service";
import { invalid } from "../../utils/errors";
import type { ToolContext } from "../tools/define";

const json = (uri: URL, data: unknown) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data, null, 1) }] });
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v) ?? "";

/** Read-only resources; each resolves strictly from database records. */
export function registerResources(server: McpServer, ctx: ToolContext): void {
  const { env, cfg } = ctx;

  server.registerResource("sources", "ghc://sources", { title: "Configured sources", description: "The official source(s) this server ingests.", mimeType: "application/json" }, async (uri) => {
    const src = await first(env.DB, "SELECT source_key, name, source_page_url, enabled, last_attempted_at, last_successful_at FROM sources ORDER BY created_at LIMIT 1");
    return json(uri, { source: src });
  });

  server.registerResource("cause-lists-by-date", new ResourceTemplate("ghc://cause-lists/{date}", { list: undefined }),
    { title: "Cause-list documents for a date", mimeType: "application/json" }, async (uri, vars) => {
      const date = one(vars.date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw invalid("date must be YYYY-MM-DD");
      return json(uri, await listDocuments(env.DB, { listing_date: date, limit: 100 }));
    });

  server.registerResource("document", new ResourceTemplate("ghc://documents/{documentId}", { list: undefined }),
    { title: "Document metadata", mimeType: "application/json" }, async (uri, vars) =>
      json(uri, await getDocumentDetails(env, cfg, one(vars.documentId))));

  server.registerResource("document-version", new ResourceTemplate("ghc://documents/{documentId}/versions/{versionId}", { list: undefined }),
    { title: "Document version", mimeType: "application/json" }, async (uri, vars) =>
      json(uri, await getDocumentDetails(env, cfg, one(vars.documentId), one(vars.versionId))));

  server.registerResource("document-page", new ResourceTemplate("ghc://documents/{documentId}/pages/{pageNumber}", { list: undefined }),
    { title: "Extracted page text (current version)", mimeType: "application/json" }, async (uri, vars) => {
      const details = await getDocumentDetails(env, cfg, one(vars.documentId));
      if (!details.version) throw invalid("The document has no stored version yet.");
      const n = Number(one(vars.pageNumber));
      if (!Number.isInteger(n) || n < 1) throw invalid("pageNumber must be a positive integer (1-based).");
      return json(uri, await getDocumentPage(env.DB, details.version.version_id, n));
    });
}
