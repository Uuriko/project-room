// W009: read-only wiki API for agents.
//
// Serves the three wiki planes as JSON for agent readers:
//   - docs/ROOM-WIKI.md               append-only experience log ("lessons")
//   - docs/history/ROOM-PROCEDURES.md validated procedures
//   - docs/*RUNBOOK*.md               runbooks
//
// The planes are embedded at build time: node scripts/wiki-build.mjs parses
// them into server/wiki-data.mjs, which this module imports. No filesystem
// reads, so the API serves identically in the Node server, the browser-gate
// runtime package, and the bundled Cloudflare worker (which has no fs).
// scripts/wiki-build.mjs --check (CI gate) fails when the embedded data is
// stale, so the served data cannot drift from the docs.
//
// The pure parsers live in server/wiki-parse.mjs (shared with the build
// script). The HTTP handler is prefix-delegated from server/http.mjs in the
// growth-handler shape: createWikiReadApi() -> { handle(pathname, method,
// searchParams) }, which returns { status, body }, null for non-wiki paths,
// or throws ServiceError for 4xx. No store, no writes, no network.
import { WIKI_DATA } from "./wiki-data.mjs";
import { searchWiki, summarizeEntry, summarizeProcedure } from "./wiki-parse.mjs";
import { ServiceError } from "./service-error.mjs";

// --- HTTP handler ------------------------------------------------------------

const ID_PATTERN = /^[a-z0-9-]+$/;

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function createWikiReadApi() {
  const byId = (rows, id) => {
    if (!ID_PATTERN.test(id)) throw new ServiceError(404, "not_found", "Not found", null);
    const row = rows.find(r => r.id === id);
    if (!row) throw new ServiceError(404, "not_found", "Not found", null);
    return row;
  };

  function handle(pathname, method, searchParams) {
    if (!pathname.startsWith("/api/wiki/")) return null;
    if (method !== "GET" && method !== "HEAD") {
      throw new ServiceError(405, "method_not_allowed", "The wiki API is read-only", { Allow: "GET, HEAD" });
    }
    const rest = pathname.slice("/api/wiki/".length);
    const [head, tail] = [rest.split("/")[0], rest.split("/").slice(1).join("/")];
    const index = WIKI_DATA;

    if (head === "procedures" && !tail) {
      const procedures = index.procedures.map(summarizeProcedure);
      return { status: 200, body: { procedures, count: procedures.length } };
    }
    if (head === "procedures" && tail && !tail.includes("/")) {
      const p = byId(index.procedures, tail);
      return { status: 200, body: { id: p.id, title: p.title, body: p.body, source: p.source } };
    }
    if (head === "entries" && !tail) {
      const limit = clampInt(searchParams.get("limit"), 20, 1, 100);
      const offset = clampInt(searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
      const page = index.entries.slice(offset, offset + limit).map(summarizeEntry);
      return { status: 200, body: { entries: page, count: page.length, total: index.entries.length, limit, offset } };
    }
    if (head === "entries" && tail && !tail.includes("/")) {
      const e = byId(index.entries, tail);
      return { status: 200, body: { id: e.id, date: e.date, slice: e.slice, agent: e.agent, tried: e.tried, outcome: e.outcome, lesson: e.lesson, rejected: e.rejected } };
    }
    if (head === "runbooks" && !tail) {
      const runbooks = index.runbooks.map(r => ({ id: r.id, title: r.title, path: r.path }));
      return { status: 200, body: { runbooks, count: runbooks.length } };
    }
    if (head === "runbooks" && tail && !tail.includes("/")) {
      const r = byId(index.runbooks, tail);
      return { status: 200, body: { id: r.id, title: r.title, path: r.path, body: r.body } };
    }
    if (head === "search" && !tail) {
      const q = searchParams.get("q");
      if (!q || !q.trim()) throw new ServiceError(400, "bad_request", "Query parameter q is required", null);
      if (q.trim().length > 200) throw new ServiceError(400, "bad_request", "Query parameter q is too long (max 200)", null);
      const limit = clampInt(searchParams.get("limit"), 20, 1, 100);
      const { procedures, entries, runbooks } = searchWiki(index, q, limit);
      const count = procedures.length + entries.length + runbooks.length;
      return { status: 200, body: { query: q.trim(), procedures, entries, runbooks, count } };
    }
    throw new ServiceError(404, "not_found", "Not found", null);
  }

  return { handle };
}
