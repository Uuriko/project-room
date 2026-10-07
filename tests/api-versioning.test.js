// API versioning + deprecation contract (audit lane F3).
// Contract: every JSON response carries X-API-Version; deprecated routes
// carry RFC 8594 Deprecation (+ optional Sunset) and a successor Link,
// registered in one frozen registry in server/api-versioning.mjs.
// Policy: docs/API-VERSIONING.md.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  API_VERSION,
  versionHeaders,
  DEPRECATIONS,
  deprecationHeadersFor,
  validateDeprecations,
} from "../server/api-versioning.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

// --- Module contract -------------------------------------------------------

test("API_VERSION is a simple integer string", () => {
  assert.equal(typeof API_VERSION, "string");
  assert.match(API_VERSION, /^\d+$/, "date versions are for the registry, the header is an integer");
});

test("versionHeaders() carries the version once", () => {
  assert.deepEqual(versionHeaders(), { "X-API-Version": API_VERSION });
});

test("deprecated land-queue routes return Deprecation + successor Link", () => {
  for (const route of ["add_land_item", "list_land_queue"]) {
    const headers = deprecationHeadersFor(`/api/rooms/commons/${route}`);
    assert.ok(headers, `${route} must be deprecated`);
    // Deprecated in openapi.yaml by 48468c09c (2026-10-05): @1791158400.
    assert.equal(headers.Deprecation, "@1791158400");
    assert.match(headers.Link ?? "", /rel="successor-version"/);
    assert.match(headers.Link ?? "", /\/api\/rooms\/commons\/work-claims/);
    // No removal is scheduled for the land-queue rows: Sunset stays absent
    // rather than inventing a deadline.
    assert.ok(!("Sunset" in headers), "no Sunset without a scheduled removal");
  }
});

test("non-deprecated routes return null", () => {
  for (const path of [
    "/api/rooms/commons",
    "/api/rooms/commons/work-claims",
    "/api/rooms/commons/remove_land_item",
    "/api/rooms/commons/report_tip",
    "/api/agent-rooms",
    "/mcp",
    "/",
    null,
    undefined,
    42,
  ]) {
    assert.equal(deprecationHeadersFor(path), null, `must not deprecate ${path}`);
  }
});

test("registry entries are well-formed and frozen", () => {
  assert.ok(Object.isFrozen(DEPRECATIONS));
  assert.ok(DEPRECATIONS.length >= 1, "at least one migrated example ships");
  for (const entry of DEPRECATIONS) {
    assert.ok(Object.isFrozen(entry), "entries are frozen");
    assert.match(entry.id, /^[a-z0-9-]+$/);
    assert.equal(typeof entry.notice, "string");
    assert.ok(entry.notice.length > 20, "notice must tell the agent what to do instead");
    assert.equal(typeof entry.test, "function");
    assert.equal(typeof entry.successorFor, "function");
    assert.match(entry.deprecation, /^(@\d+|true)$/);
  }
});

test("validateDeprecations accepts the shipped registry", () => {
  validateDeprecations(DEPRECATIONS, Date.parse("2026-10-07T00:00:00Z"));
});

test("validateDeprecations rejects a sunset inside the 90-day notice window", () => {
  const now = Date.parse("2026-10-07T00:00:00Z");
  const soon = new Date(now + 30 * 86400 * 1000).toUTCString();
  const entry = {
    id: "too-soon",
    notice: "use the other thing instead",
    deprecation: "@1791158400",
    sunset: soon,
    test: () => null,
    successorFor: () => "/api/rooms/x/work-claims",
  };
  assert.throws(() => validateDeprecations([entry], now), /90/);
});

test("validateDeprecations rejects a sunset in the past", () => {
  const now = Date.parse("2027-06-01T00:00:00Z");
  const entry = {
    id: "already-gone",
    notice: "use the other thing instead",
    deprecation: "@1791158400",
    sunset: "Mon, 01 Mar 2027 00:00:00 GMT",
    test: () => null,
    successorFor: () => "/api/rooms/x/work-claims",
  };
  assert.throws(() => validateDeprecations([entry], now), /past/);
});

test("Sunset header is emitted when a deprecation sets one", () => {
  const sunset = "Mon, 01 Mar 2027 00:00:00 GMT";
  const entry = {
    id: "with-sunset",
    notice: "use the other thing instead",
    deprecation: "@1791158400",
    sunset,
    test: (pathname) => /^\/api\/rooms\/([^/]+)\/old_thing$/.exec(pathname),
    successorFor: (m) => `/api/rooms/${m[1]}/new_thing`,
  };
  const headers = deprecationHeadersFor("/api/rooms/commons/old_thing", [entry]);
  assert.equal(headers.Sunset, sunset);
  assert.equal(headers.Deprecation, "@1791158400");
  assert.match(headers.Link, /\/api\/rooms\/commons\/new_thing/);
});

// --- Live wire-in -----------------------------------------------------------

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-apiver-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => Date.parse("2026-10-07T00:00:00Z") });
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, ownerKey };
}

async function listen(t, store) {
  const server = createRoomServer({ store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("live: deprecated list_land_queue carries Deprecation + X-API-Version", async (t) => {
  const f = fixture(t);
  const origin = await listen(t, f.store);
  const res = await fetch(`${origin}/api/rooms/commons/list_land_queue`, {
    headers: { authorization: `Bearer ${f.ownerKey}` },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-api-version"), API_VERSION);
  assert.equal(res.headers.get("deprecation"), "@1791158400");
  assert.match(res.headers.get("link") ?? "", /rel="successor-version"/);
});

test("live: deprecated add_land_item carries Deprecation on the 201", async (t) => {
  const f = fixture(t);
  // landQueue.add verifies the PR against GitHub; mock it like land-queue.test.js.
  const scene = {
    pr: { title: "t", merged: false, mergeable: true, mergeable_state: "clean", head: { sha: "a".repeat(40) } },
    status: { state: "pending" },
    checks: { check_runs: [] },
  };
  f.store.landQueue.configure({
    fetchImpl: async (url) => {
      const body = url.includes("/check-runs") ? scene.checks : url.endsWith("/status") ? scene.status : scene.pr;
      return { status: 200, ok: true, json: async () => body };
    },
  });
  const origin = await listen(t, f.store);
  const res = await fetch(`${origin}/api/rooms/commons/add_land_item`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${f.ownerKey}` },
    body: JSON.stringify({ repo: "acme/demo", prNumber: 4242 }),
  });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("deprecation"), "@1791158400");
  assert.equal(res.headers.get("x-api-version"), API_VERSION);
});

test("live: HEAD on a deprecated route still carries the headers", async (t) => {
  const f = fixture(t);
  const origin = await listen(t, f.store);
  const res = await fetch(`${origin}/api/rooms/commons/list_land_queue`, {
    method: "HEAD",
    headers: { authorization: `Bearer ${f.ownerKey}` },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("deprecation"), "@1791158400");
});

test("live: error responses on a deprecated route carry the headers too", async (t) => {
  const f = fixture(t);
  const origin = await listen(t, f.store);
  // No credential: the route rejects 401 before the handler body runs.
  const res = await fetch(`${origin}/api/rooms/commons/list_land_queue`);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("x-api-version"), API_VERSION);
  assert.equal(res.headers.get("deprecation"), "@1791158400");
});

test("live: a non-deprecated route has X-API-Version but no Deprecation", async (t) => {
  const f = fixture(t);
  const origin = await listen(t, f.store);
  const res = await fetch(`${origin}/api/rooms/commons/no-such-route`, {
    headers: { authorization: `Bearer ${f.ownerKey}` },
  });
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("x-api-version"), API_VERSION);
  assert.equal(res.headers.get("deprecation"), null);
});
