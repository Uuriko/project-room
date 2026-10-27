// Track C C14 growth surface — route-table registration (clean-slate
// lane-25 F-4). The three GET routes were delegated in server/http.mjs only
// when the optional growth handle is injected, and were invisible to every
// route registry (the extractor never scans src/growth-http.js).
//
// The live handle is request-scoped state owned by the server factory, so
// it reaches this handler as ctx.growth (server/http.mjs passes it into
// dispatchRoute). When it is absent (growth paused), the handler rejects
// 404 — the same terminal answer the legacy fall-through produced. When it
// is present, the reply passes through verbatim, including the handler's
// own failure isolation: a throwing handle degrades to the same 503 body
// the delegation returned. The http.mjs delegation remains as the
// fall-through for unregistered /growth/* subpaths.

export function growthRoute(ctx) {
  if (!ctx.growth) ctx.reject(404, "not_found", "Not found");
  let reply = null;
  try {
    reply = ctx.growth.handle(ctx.url.pathname, ctx.req.method, ctx.url.searchParams);
  } catch {
    return ctx.json(ctx.res, 503, { status: "unavailable", reason: "growth_unavailable" });
  }
  if (!reply) ctx.reject(404, "not_found", "Not found");
  return ctx.json(ctx.res, reply.status, reply.body);
}

const GROWTH_PARITY = "exempt:operator growth analytics surface; no MCP tool serves it";

export const GROWTH_ROUTES = Object.freeze(["/growth/summary", "/growth/digest", "/growth/health"].flatMap(path =>
  ["GET", "HEAD"].map(method => Object.freeze({
    id: `growth.${path.split("/")[2]}-${method.toLowerCase()}`, method, path, auth: "none", capability: null,
    scope: "public", handler: growthRoute, parity: GROWTH_PARITY,
    schema: { response: { type: "object" } }, events: [],
  }))));
