// Route documentation gate (re-audit 2026-09-14, M4).
//
// docs/openapi.yaml must describe every /api route template the server can
// match, and must not describe one the server no longer serves. The served
// set comes from routeCandidates() in scripts/open-routes.mjs (the same
// extraction tests/invite-only-boundary.test.js probes anonymously), plus
// the agent plug-in surface mounted through a single delegation in
// server/http.mjs (extracted from server/agent-plugin-routes.mjs below).
// the documented set is every key under `paths:`. Path parameters are
// reduced to {} on both sides so {roomId}, {id} and :roomId compare equal.
// A new route fails `npm run check` until it is documented with its
// security scheme, request body and responses.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { openapiOperations, routeCandidates } from "./open-routes.mjs";

export const templateKey = path => path.replace(/\{[^}]+\}|:[A-Za-z]+/g, "{}");

// One shared route set for the CLI gate and the test suite: every source
// the gate compares lives here, so a new source can never be visible to the
// gate and invisible to the tests (or vice versa).
export function routeSources(root) {
  const read = path => readFileSync(join(root, path), "utf8");
  return {
    http: read("server/http.mjs"),
    pluginRoutes: read("server/agent-plugin-routes.mjs"),
    nextActionsRoutes: read("server/next-actions-routes.mjs"),
    worker: read("cloudflare/room.mjs"),
    openapi: read("docs/openapi.yaml"),
  };
}

// Agent plug-in routes live in server/agent-plugin-routes.mjs as exact
// pathname literals ("pathname === \"/api/agent-keys\"") and anchored route
// regexes (/^\/api\/agent-keys\/(...)\/(...)$/). Both forms reduce to
// templates; regex groups become {id} (templateKey normalises the names on
// the documented side too).
export function pluginRouteTemplates(source) {
  const routes = new Set();
  for (const match of source.matchAll(/"(\/api\/[^"\s]*[^"\s/])"/g)) routes.add(match[1]);
  for (const match of source.matchAll(/\/\^((?:\\\/|[^$/])+)\$\//g)) {
    const template = match[1].replaceAll("\\/", "/").replace(/\([^()]*\)/g, "{id}");
    if (/[\\^$]/.test(template)) throw new Error(`plugin route regex not expanded: ${template}`);
    routes.add(template);
  }
  return [...routes].sort();
}

// Next-actions routes live in server/next-actions-routes.mjs as one anchored
// regex whose tail is an alternation group
// (/^\/api\/rooms\/([^/]{1,384})\/(next-actions|…)$/). The alternation expands
// to one template per route; every other group becomes {id}, like the
// plug-in extractor above.
export function nextActionsRouteTemplates(source) {
  const routes = new Set();
  for (const match of source.matchAll(/\/\^((?:\\\/|[^$/])+)\$\//g)) {
    const template = match[1].replaceAll("\\/", "/");
    const alternation = /\(([^()]*\|[^()]*)\)/.exec(template);
    const variants = alternation
      ? alternation[1].split("|").map(part => template.replace(alternation[0], part))
      : [template];
    for (const variant of variants) {
      const expanded = variant.replace(/\([^()]*\)/g, "{id}");
      if (/[\\^$]/.test(expanded)) throw new Error(`next-actions route regex not expanded: ${expanded}`);
      routes.add(expanded);
    }
  }
  return [...routes].sort();
}

// Worker-served routes live in cloudflare/room.mjs as exact pathname
// literals (url.pathname === '/api/health/jobs'): answers the Worker gives
// before or instead of forwarding to the Durable Object. A trailing-slash
// sibling of a route is the same route. The Worker surface is small and
// stable, so every literal found here must be documented like any other.
export function workerRouteTemplates(source) {
  const routes = new Set();
  for (const match of source.matchAll(/url\.pathname === '(\/api\/[^']+)'/g)) {
    const path = match[1].replace(/\/+$/, "");
    if (path) routes.add(path);
  }
  return [...routes].sort();
}

export function routeDocsDrift({ http, pluginRoutes, nextActionsRoutes, worker, openapi }) {
  const served = new Map();
  // server/http.mjs also names "/api/rooms/:roomId" as a diagnostics label; it folds into the {roomId} template.
  for (const template of routeCandidates(http)) if (!served.has(templateKey(template)) || !template.includes(":")) served.set(templateKey(template), template);
  // Required, not optional. Routes live in two files now, and a caller that
  // passed only http.mjs got a clean-looking report in which every plugin
  // route was "documented but not served" - which is how the test beside this
  // drifted into failing on a dozen phantom routes while the gate itself was
  // green. An omission should be an error, not a wrong answer.
  if (typeof pluginRoutes !== "string") throw new Error("routeDocsDrift needs server/agent-plugin-routes.mjs; routes are served from two files");
  {
    for (const template of pluginRouteTemplates(pluginRoutes)) {
      const key = templateKey(template);
      if (!served.has(key)) served.set(key, template);
    }
  }
  // RC-2026-09-25-911: the next-actions surface is a third route source.
  if (typeof nextActionsRoutes !== "string") throw new Error("routeDocsDrift needs server/next-actions-routes.mjs; routes are served from three files");
  {
    for (const template of nextActionsRouteTemplates(nextActionsRoutes)) {
      const key = templateKey(template);
      if (!served.has(key)) served.set(key, template);
    }
  }
  // RC-2026-09-26-002: the Worker surface (cloudflare/room.mjs) is the
  // fourth route source - routes answered before or instead of the Durable
  // Object were invisible to this gate (/api/health/jobs until now).
  if (typeof worker !== "string") throw new Error("routeDocsDrift needs cloudflare/room.mjs; routes are served from four files");
  {
    for (const template of workerRouteTemplates(worker)) {
      const key = templateKey(template);
      if (!served.has(key)) served.set(key, template);
    }
  }
  const operations = openapiOperations(openapi);
  const documented = new Map();
  // /api templates are the gate. Hosted MCP (/mcp, /room/mcp) is documented
  // in the spec and probed on its own; it is not an /api route template.
  for (const { path } of operations) {
    if (!path.startsWith("/api/")) continue;
    if (!documented.has(templateKey(path))) documented.set(templateKey(path), path);
  }
  if (served.size < 50 || !served.has("/api/health") || !served.has("/api/rooms/{}/commands") || !served.has("/api/health/jobs")) throw new Error("server route extraction sanity failed");
  if (documented.size < 20 || !documented.has("/api/rooms/{}/commands")) throw new Error("docs/openapi.yaml parse sanity failed");
  const failures = [];
  for (const [key, template] of served) if (!documented.has(key)) failures.push(`served but not documented in docs/openapi.yaml: ${template}`);
  for (const [key, path] of documented) if (!served.has(key)) failures.push(`documented in docs/openapi.yaml but not served: ${path}`);
  for (const op of operations) if (op.security === null && /^\/api\/(inbox|account-)/.test(op.path))
    failures.push(`${op.method} ${op.path} inherits the room-credential default; account routes must declare accountSession or security: []`);
  return { failures, served: served.size, documented: documented.size, operations: operations.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const result = routeDocsDrift(routeSources(root));
  if (result.failures.length) {
    console.error("Route documentation drift:\n" + result.failures.map(f => `  ${f}`).join("\n"));
    process.exit(1);
  }
  console.log(`Route documentation: ${result.served} served route templates, all in docs/openapi.yaml (${result.operations} operations).`);
}
