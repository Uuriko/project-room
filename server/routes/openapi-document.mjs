// Full OpenAPI document. The legacy allowlist only shrinks, so these routes
// live in the table. GET /openapi.json stays the smaller curated inventory.
import { ifNoneMatch, openApiDocumentFromYaml } from "../openapi-document.mjs";

const CACHE = "public, max-age=300";

export async function serveOpenApiSpec(ctx) {
  let raw;
  try { raw = await ctx.loadAsset("docs/openapi.yaml"); }
  catch { ctx.reject(404, "not_found", "Not found"); }
  if (!raw) ctx.reject(404, "not_found", "Not found");
  let document;
  try { document = openApiDocumentFromYaml(raw); }
  catch { ctx.reject(500, "internal_error", "OpenAPI document is unavailable"); }
  const yaml = ctx.url.pathname.endsWith(".yaml");
  const body = yaml ? document.yamlBytes : document.jsonBytes;
  const headers = { "Cache-Control": CACHE, ETag: document.etag, "X-Robots-Tag": "all" };
  if (ifNoneMatch(ctx.req.headers["if-none-match"], document.etag)) {
    ctx.res.writeHead(304, { ...headers, "Content-Length": 0 });
    ctx.res.end();
    return;
  }
  ctx.res.writeHead(200, {
    ...headers,
    "Content-Type": `${yaml ? "application/yaml" : "application/json"}; charset=utf-8`,
    "Content-Length": body.byteLength,
  });
  ctx.res.end(ctx.req.method === "HEAD" ? undefined : body);
}

function row(method, path) {
  const kind = path.endsWith(".yaml") ? "yaml" : "json";
  return Object.freeze({
    id: `openapi-spec-${kind}-${method.toLowerCase()}`,
    method,
    path,
    auth: "none",
    capability: null,
    scope: "public",
    handler: serveOpenApiSpec,
    parity: "exempt:this route is the OpenAPI catalog, not an MCP action",
    schema: { response: { type: "object" } },
    events: [],
  });
}

export const OPENAPI_DOCUMENT_ROUTES = Object.freeze([
  row("GET", "/api/openapi.yaml"),
  row("HEAD", "/api/openapi.yaml"),
  row("GET", "/api/openapi.json"),
  row("HEAD", "/api/openapi.json"),
]);
