// Direct unit coverage for the wiki + growth route-table adapters
// (clean-slate routes-17). tests/wiki-read-api.test.js pins the wiki API
// itself over HTTP; this file pins the route adapters' own behaviour —
// request in, ctx.json / ctx.reject effects out — and satisfies the
// untested-server-module gate (scripts/untested-modules-lint.mjs) for
// server/routes/wiki.mjs and server/routes/growth.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { WIKI_ROUTES, wikiRoute } from "../server/routes/wiki.mjs";
import { GROWTH_ROUTES, growthRoute } from "../server/routes/growth.mjs";
import { createWikiReadApi } from "../server/wiki-read-api.mjs";
import { ServiceError } from "../server/service-error.mjs";

function wikiCtx(pathname, { method = "GET", query = "" } = {}) {
  const calls = [];
  return {
    calls,
    req: { method },
    res: {},
    url: new URL(`http://room.test${pathname}${query}`),
    json: (res, status, body, head) => { calls.push({ status, body, head }); return body; },
  };
}

function growthCtx(pathname, { method = "GET", growth = null } = {}) {
  const calls = [];
  const rejections = [];
  return {
    calls,
    rejections,
    req: { method },
    res: {},
    url: new URL(`http://room.test${pathname}`),
    growth,
    json: (res, status, body) => { calls.push({ status, body }); return body; },
    reject: (status, code, message) => {
      rejections.push({ status, code, message });
      throw new ServiceError(status, code, message);
    },
  };
}

test("wiki rows: 7 templates x GET+HEAD, public, one handler", () => {
  assert.equal(WIKI_ROUTES.length, 14);
  assert.equal(new Set(WIKI_ROUTES.map(row => row.id)).size, 14, "row ids are unique");
  const templates = [...new Set(WIKI_ROUTES.map(row => row.path))].sort();
  assert.deepEqual(templates, [
    "/api/wiki/entries",
    "/api/wiki/entries/{id}",
    "/api/wiki/procedures",
    "/api/wiki/procedures/{id}",
    "/api/wiki/runbooks",
    "/api/wiki/runbooks/{id}",
    "/api/wiki/search",
  ]);
  for (const row of WIKI_ROUTES) {
    assert.equal(row.auth, "none", `${row.id} is public`);
    assert.equal(row.scope, "public");
    assert.equal(row.handler, wikiRoute);
    assert.match(row.parity, /^exempt:/);
    assert.deepEqual(
      WIKI_ROUTES.filter(other => other.path === row.path).map(other => other.method).sort(),
      ["GET", "HEAD"],
      `${row.path} serves GET and HEAD`,
    );
  }
});

test("wikiRoute: list answers match the wiki API verbatim", () => {
  const direct = createWikiReadApi().handle("/api/wiki/procedures", "GET", new URLSearchParams());
  const ctx = wikiCtx("/api/wiki/procedures");
  wikiRoute(ctx);
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].status, 200);
  assert.deepEqual(ctx.calls[0].body, direct.body);
  assert.equal(ctx.calls[0].body.count, ctx.calls[0].body.procedures.length);
  assert.ok(ctx.calls[0].body.count > 0, "embedded wiki data is non-empty");
  assert.equal(ctx.calls[0].head, false, "GET does not suppress the body");
});

test("wikiRoute: a listed id reads back through the adapter", () => {
  const list = wikiCtx("/api/wiki/procedures");
  wikiRoute(list);
  const first = list.calls[0].body.procedures[0];
  const ctx = wikiCtx(`/api/wiki/procedures/${first.id}`);
  wikiRoute(ctx);
  assert.equal(ctx.calls[0].status, 200);
  assert.equal(ctx.calls[0].body.id, first.id);
  assert.equal(typeof ctx.calls[0].body.body, "string");
  assert.ok(ctx.calls[0].body.body.length > 0, "detail serves the full body, not the summary");
});

test("wikiRoute: entries paging reaches the handler through searchParams", () => {
  const ctx = wikiCtx("/api/wiki/entries", { query: "?limit=1&offset=0" });
  wikiRoute(ctx);
  assert.equal(ctx.calls[0].status, 200);
  assert.equal(ctx.calls[0].body.limit, 1);
  assert.equal(ctx.calls[0].body.count, 1);
  assert.ok(ctx.calls[0].body.total > 1, "total counts the whole plane, not the page");
});

test("wikiRoute: HEAD passes the body-suppression flag", () => {
  const ctx = wikiCtx("/api/wiki/runbooks", { method: "HEAD" });
  wikiRoute(ctx);
  assert.equal(ctx.calls[0].status, 200);
  assert.equal(ctx.calls[0].head, true);
});

test("wikiRoute: unknown id throws the wiki_not_found ServiceError", () => {
  const ctx = wikiCtx("/api/wiki/procedures/no-such-procedure");
  assert.throws(() => wikiRoute(ctx), error =>
    error instanceof ServiceError && error.status === 404 && error.code === "wiki_not_found");
  assert.equal(ctx.calls.length, 0, "no reply is written on the error path");
});

test("wikiRoute: search requires q and echoes a served query", () => {
  const bare = wikiCtx("/api/wiki/search");
  assert.throws(() => wikiRoute(bare), error =>
    error instanceof ServiceError && error.status === 400 && error.code === "bad_request");
  const ctx = wikiCtx("/api/wiki/search", { query: "?q=claim" });
  wikiRoute(ctx);
  assert.equal(ctx.calls[0].status, 200);
  assert.equal(ctx.calls[0].body.query, "claim");
  const total = ctx.calls[0].body.procedures.length
    + ctx.calls[0].body.entries.length + ctx.calls[0].body.runbooks.length;
  assert.equal(ctx.calls[0].body.count, total);
});

test("growth rows: 3 paths x GET+HEAD, public, one handler", () => {
  assert.equal(GROWTH_ROUTES.length, 6);
  assert.equal(new Set(GROWTH_ROUTES.map(row => row.id)).size, 6, "row ids are unique");
  assert.deepEqual([...new Set(GROWTH_ROUTES.map(row => row.path))].sort(),
    ["/growth/digest", "/growth/health", "/growth/summary"]);
  for (const row of GROWTH_ROUTES) {
    assert.equal(row.auth, "none", `${row.id} is public`);
    assert.equal(row.scope, "public");
    assert.equal(row.handler, growthRoute);
    assert.match(row.parity, /^exempt:/);
  }
});

test("growthRoute: a paused surface (no handle) rejects 404 not_found", () => {
  const ctx = growthCtx("/growth/summary");
  assert.throws(() => growthRoute(ctx), error =>
    error instanceof ServiceError && error.status === 404 && error.code === "not_found");
  assert.deepEqual(ctx.rejections, [{ status: 404, code: "not_found", message: "Not found" }]);
  assert.equal(ctx.calls.length, 0);
});

test("growthRoute: the handle's reply passes through verbatim", () => {
  const seen = [];
  const growth = {
    handle: (pathname, method, searchParams) => {
      seen.push([pathname, method, searchParams instanceof URLSearchParams]);
      return { status: 200, body: { summary: { visitors: 3 } } };
    },
  };
  const ctx = growthCtx("/growth/summary", { growth });
  growthRoute(ctx);
  assert.deepEqual(seen, [["/growth/summary", "GET", true]]);
  assert.deepEqual(ctx.calls, [{ status: 200, body: { summary: { visitors: 3 } } }]);
  assert.equal(ctx.rejections.length, 0);
});

test("growthRoute: HEAD is forwarded to the handle", () => {
  const seen = [];
  const growth = {
    handle: (pathname, method) => { seen.push(method); return { status: 200, body: { status: "ok" } }; },
  };
  const ctx = growthCtx("/growth/health", { method: "HEAD", growth });
  growthRoute(ctx);
  assert.deepEqual(seen, ["HEAD"]);
  assert.equal(ctx.calls[0].status, 200);
});

test("growthRoute: a null reply from the handle rejects 404", () => {
  const ctx = growthCtx("/growth/digest", { growth: { handle: () => null } });
  assert.throws(() => growthRoute(ctx), error =>
    error instanceof ServiceError && error.status === 404 && error.code === "not_found");
  assert.equal(ctx.calls.length, 0);
});

test("growthRoute: a throwing handle degrades to the 503 growth_unavailable body", () => {
  const growth = { handle: () => { throw new Error("collector down"); } };
  const ctx = growthCtx("/growth/summary", { growth });
  growthRoute(ctx);
  assert.deepEqual(ctx.calls, [{ status: 503, body: { status: "unavailable", reason: "growth_unavailable" } }]);
  assert.equal(ctx.rejections.length, 0, "failure isolation: no rejection escapes");
});
