// One MCP server card. Paths are aliases of this document; nothing else
// hand-writes a second copy. Tools are supplied by the live registry.

export const MCP_SERVER_CARD_PATH = "/mcp/server-card";
export const MCP_SERVER_CARD_SCHEMA = "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";
export const MCP_SERVER_CARD_MEDIA_TYPE = "application/mcp-server-card+json; charset=utf-8";
export const MCP_SERVER_CARD_NAME = "io.github.Uuriko/project-room";
export const MCP_SERVER_CARD_DESCRIPTION = "Project Room MCP: public join tools, or Bearer enrolled full room tools. No OAuth.";
export const MCP_SERVER_CARD_TITLE = "Uuriko Project Room";

// MCP caching (2026-07-28): ttlMs is max-age in milliseconds; cacheScope
// public means the document has no per-caller data. HTTP Cache-Control
// uses the same lifetime.
export const MCP_DISCOVERY_CACHE_SCOPE = "public";
export const MCP_DISCOVERY_TTL_MS = 3_600_000;
export const MCP_DISCOVERY_CACHE_CONTROL = `public, max-age=${MCP_DISCOVERY_TTL_MS / 1000}`;

export const MCP_SERVER_CARD_CORS = Object.freeze({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
  "Access-Control-Expose-Headers": "ETag"
});

function projectTools(tools) {
  return JSON.parse(JSON.stringify(tools));
}

export function renderMcpServerCardJson({
  publicTools,
  enrolledTools,
  url,
  mint,
  version,
  protocolVersions,
  websiteUrl,
  repositoryUrl
}) {
  if (typeof MCP_SERVER_CARD_DESCRIPTION !== "string"
    || MCP_SERVER_CARD_DESCRIPTION.length < 1
    || MCP_SERVER_CARD_DESCRIPTION.length > 100) {
    throw new Error("MCP server card description must be 1..100 characters");
  }
  if (!Array.isArray(publicTools) || !Array.isArray(enrolledTools)) {
    throw new Error("MCP server card requires the live public and enrolled tool lists");
  }
  return JSON.stringify({
    $schema: MCP_SERVER_CARD_SCHEMA,
    name: MCP_SERVER_CARD_NAME,
    version,
    description: MCP_SERVER_CARD_DESCRIPTION,
    title: MCP_SERVER_CARD_TITLE,
    websiteUrl,
    repository: { url: repositoryUrl, source: "github" },
    remotes: [{
      type: "streamable-http",
      url,
      supportedProtocolVersions: [...protocolVersions],
      headers: [{
        name: "Authorization",
        description: "Identity secret for the enrolled room profile. Omit this header for the public join tools.",
        isRequired: false,
        isSecret: true
      }]
    }],
    protocol: "mcp",
    transport: "streamable-http",
    url,
    oauth: false,
    auth: {
      type: "bearer",
      header: "Authorization",
      scheme: "Bearer",
      mint
    },
    cacheScope: MCP_DISCOVERY_CACHE_SCOPE,
    ttlMs: MCP_DISCOVERY_TTL_MS,
    tools: {
      public: projectTools(publicTools),
      enrolled: projectTools(enrolledTools)
    }
  }, null, 2) + "\n";
}
