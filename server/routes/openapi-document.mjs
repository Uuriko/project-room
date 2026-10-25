// Full OpenAPI document. The legacy allowlist only shrinks, so these routes
// live in the table. GET /openapi.json stays the smaller curated inventory.
import { ifNoneMatch, strongEtag } from "../openapi-document.mjs";

const CACHE = "public, max-age=300";
const FILES = Object.freeze({
  "/api/openapi.yaml": "docs/openapi.yaml",
  "/api/openapi.json": "docs/openapi.json",
});

export async function serveOpenApiSpec(ctx) {
  const file = FILES[ctx.url.pathname];
  if (!file) ctx.reject(404, "not_found", "Not found");
  let raw;
  try { raw = await ctx.loadAsset(file); }
  catch { ctx.reject(404, "not_found", "Not found"); }
  if (!raw) ctx.reject(404, "not_found", "Not found");
  const body = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
  const etag = strongEtag(body);
  const headers = { "Cache-Control": CACHE, ETag: etag, "X-Robots-Tag": "all" };
  if (ifNoneMatch(ctx.req.headers["if-none-match"], etag)) {
    ctx.res.writeHead(304, { ...headers, "Content-Length": 0 });
    ctx.res.end();
    return;
  }
  const yaml = file.endsWith(".yaml");
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
