// W009 wiki read API — route-table registration (clean-slate lane-25 F-3).
//
// The wiki planes were prefix-delegated in server/http.mjs and invisible to
// every route registry (the routes-inventory extractor never scans
// server/wiki-read-api.mjs, and the frozen legacy baseline cannot absorb new
// entries). These rows register the seven templates the wiki handler serves
// (GET + HEAD each, the 14 method keys of lane-25 F-3) in the table instead.
// The handler is a thin adapter over a module-level wiki API instance — the
// API is stateless (embedded wiki-data, no store, no I/O), so this instance
// answers identically to the one server/http.mjs delegates to, and the
// prefix delegation remains as the fall-through for unregistered
// /api/wiki/* subpaths and methods. ServiceError throws from the wiki
// handler propagate to the same outer catch as before, so the canonical
// error envelope is unchanged.

import { createWikiReadApi } from "../wiki-read-api.mjs";

const wikiReadApi = createWikiReadApi();

export function wikiRoute(ctx) {
  const reply = wikiReadApi.handle(ctx.url.pathname, ctx.req.method, ctx.url.searchParams);
  return ctx.json(ctx.res, reply.status, reply.body, ctx.req.method === "HEAD");
}

const WIKI_PARITY = "exempt:public read-only wiki API for agents; no MCP tool serves the wiki planes";

const WIKI_TEMPLATES = [
  ["wiki.procedures", "/api/wiki/procedures"],
  ["wiki.procedure", "/api/wiki/procedures/{id}"],
  ["wiki.entries", "/api/wiki/entries"],
  ["wiki.entry", "/api/wiki/entries/{id}"],
  ["wiki.runbooks", "/api/wiki/runbooks"],
  ["wiki.runbook", "/api/wiki/runbooks/{id}"],
  ["wiki.search", "/api/wiki/search"],
];

export const WIKI_ROUTES = Object.freeze(WIKI_TEMPLATES.flatMap(([base, path]) =>
  ["GET", "HEAD"].map(method => Object.freeze({
    id: `${base}-${method.toLowerCase()}`, method, path, auth: "none", capability: null,
    scope: "public", handler: wikiRoute, parity: WIKI_PARITY,
    schema: { response: { type: "object" } }, events: [],
  }))));
