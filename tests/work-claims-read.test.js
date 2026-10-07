// Contract tests for GET /api/rooms/{roomId}/work-claims-read (PR #1468).
//
// The route ships the canonical stored Board claim projection over REST: a
// read-only page of claims with no claim lifecycle housekeeping (expired
// leases are NOT auto-released here, unlike the ordinary work-claims list).
//
// Authoring gate (per .agents/skills/test-audit/SKILL.md):
// 1. Contracts: the route-table row (method, path, auth, scope, schema), the
//    room/API-key read guard, the response shape, the query validation, and
//    the read-without-housekeeping behavior.
// 2. Credible regressions: the row dropped from the mounted table (404), the
//    row's scope relaxed, limit/state/cursor validation removed, history
//    tails served uncompacted, or the handler gaining lease housekeeping.
// 3. No existing coverage: the route is new in PR #1468; nothing else asserts
//    its row or its HTTP contract.
// 4. No production seams: route rows are imported directly; behavior goes
//    through a real server built from the same ROUTES table the app mounts.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { WORK_CLAIM_ROUTES } from "../server/routes/work-claims.mjs";
import { ROUTES } from "../server/routes/table.mjs";
import { matchRoute, dispatchRoute } from "../server/routes/dispatch.mjs";
import { ServiceError } from "../server/service-error.mjs";
import { createWork, claimWork, updateWork } from "../server/work-claims.mjs";

const H = 3600 * 1000;
const DAY = 24 * H;
const PATH = "/api/rooms/commons/work-claims-read";

const findRow = () => WORK_CLAIM_ROUTES.find(route => route.id === "work-claims-read");
const cursorOf = value => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

// --- route-table registration ---

test("work-claims-read is registered exactly once with the documented row", () => {
  const rows = WORK_CLAIM_ROUTES.filter(route => route.id === "work-claims-read");
  assert.equal(rows.length, 1, "exactly one work-claims-read route row");
  const [row] = rows;
  assert.equal(row.method, "GET");
  assert.equal(row.path, "/api/rooms/{roomId}/work-claims-read");
  assert.equal(row.auth, "room");
  assert.equal(row.capability, null);
  assert.equal(row.scope, "room");
  assert.deepEqual(row.schema.params.required, ["roomId"]);
  assert.equal(row.schema.params.properties.roomId.type, "string");
  assert.equal(row.schema.response.type, "object");
  assert.deepEqual(row.events, []);
  assert.equal(typeof row.handler, "function");
  assert.equal(row.handler.name, "getWorkClaimsRead");
});

test("work-claims-read is mounted in the app route table", () => {
  const row = findRow();
  assert.ok(row, "route row exists");
  assert.ok(ROUTES.includes(row), "the mounted ROUTES table carries the row");
});

test("the dispatcher binds {roomId} and 405s non-GET methods before any handler runs", async () => {
  const found = matchRoute(WORK_CLAIM_ROUTES, "GET", "/api/rooms/room-1/work-claims-read");
  assert.ok(found?.row, "GET matches a row");
  assert.equal(found.row.id, "work-claims-read");
  assert.equal(found.params.roomId, "room-1");

  let status = 0;
  let code = "";
  let allow = "";
  const res = { setHeader: (name, value) => { if (String(name).toLowerCase() === "allow") allow = value; } };
  await assert.rejects(
    dispatchRoute({
      req: { method: "POST" },
      url: new URL("http://127.0.0.1/api/rooms/room-1/work-claims-read"),
      res,
      reject: (s, c) => { status = s; code = c; throw new ServiceError(s, c, "stop"); },
    }, WORK_CLAIM_ROUTES),
    ServiceError,
  );
  assert.equal(status, 405);
  assert.equal(code, "method_not_allowed");
  assert.equal(allow, "GET");
});

// --- HTTP harness ---

async function serve(t, seed = null) {
  const fixture = createAcceptanceFixture();
  if (seed) seed(fixture.store);
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const ownerKey = fixture.store.issueAccessKey("commons", "owner");
  const get = (query = "", token = ownerKey) => fetch(`${origin}${PATH}${query}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { origin, store: fixture.store, ownerKey, get };
}

const errorOf = async res => {
  const body = await res.json();
  return { status: res.status, code: body?.error?.code, message: body?.error?.message ?? "" };
};

// --- auth behavior ---

test("unauthenticated reads are rejected with 401", async t => {
  const { get } = await serve(t);
  const err = await errorOf(await get("", null));
  assert.equal(err.status, 401);
  assert.equal(err.code, "unauthenticated");
});

test("an unknown Bearer <redacted> is rejected with 401", async t => {
  const { get } = await serve(t);
  const err = await errorOf(await get("", "definitely-not-a-key"));
  assert.equal(err.status, 401);
  assert.equal(err.code, "unauthenticated");
});

test("an API key without the rooms:read scope is rejected with 403", async t => {
  const { origin, store, ownerKey, get } = await serve(t);
  const identity = store.identities.create("wcr-scope-probe");
  const link = await fetch(`${origin}/api/rooms/commons/identity-links`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
    body: JSON.stringify({ identityId: identity.identityId, permissions: ["accept_work", "complete_work"] }),
  });
  assert.equal(link.status, 201, "identity links as a room member");
  const issue = async scopes => {
    const res = await fetch(`${origin}/api/agent-keys`, {
      method: "POST",
      headers: { authorization: `Bearer ${identity.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ scopes }),
    });
    assert.equal(res.status, 201);
    return (await res.json()).credential;
  };
  const scopedOut = await issue(["directory:publish"]);
  const err = await errorOf(await get("", scopedOut));
  assert.equal(err.status, 403);
  assert.equal(err.code, "insufficient_scope");

  // Positive control: the same identity with rooms:read passes the guard.
  const scopedIn = await issue(["rooms:read"]);
  const ok = await get("", scopedIn);
  assert.equal(ok.status, 200);
});

// --- response shape ---

function seedBoard(store) {
  const now = Date.now();
  const put = item => store.workClaims.set("commons", item);
  put(createWork({ id: "ready-1", title: "ready one" }, { now: now - 5 * H }));
  const claimedAt = now - 4 * H;
  let done = createWork({ id: "done-1", title: "done one" }, { now: now - 5 * H });
  done = claimWork(done, "owner", { now: claimedAt });
  done = updateWork(done, "owner", { state: "in_progress", now: claimedAt + H });
  done = updateWork(done, "owner", { state: "done", now: claimedAt + 2 * H });
  put(done);
}

test("a member read returns the documented page shape", async t => {
  const { get } = await serve(t, seedBoard);
  const res = await get();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.roomId, "commons");
  assert.equal(body.source, "work-claims");
  assert.equal(body.consistency, "live");
  assert.ok(!Number.isNaN(Date.parse(body.evaluatedAt)), "evaluatedAt is an ISO timestamp");
  assert.equal(body.limit, 50, "default limit");
  assert.equal(body.historyLimit, 3, "compacted history tail");
  assert.equal(body.historyScope, "recent_done_and_dependencies");
  assert.ok(Array.isArray(body.claims));
  assert.equal(typeof body.hasMore, "boolean");
  assert.ok("nextCursor" in body);
  const ids = body.claims.map(claim => claim.id);
  assert.ok(ids.includes("ready-1") && ids.includes("done-1"), "seeded claims are projected");
  for (const claim of body.claims) {
    assert.equal(typeof claim.id, "string");
    assert.equal(typeof claim.state, "string");
    assert.ok(Array.isArray(claim.history), "claims carry a history tail");
    assert.ok(claim.history.length <= 3, "history is compacted to the newest entries");
  }
});

test("list history tails are compacted with the remainder counted", async t => {
  const { get } = await serve(t, seedBoard);
  const body = await (await get("?state=done")).json();
  const done = body.claims.find(claim => claim.id === "done-1");
  assert.ok(done, "done claim is listed");
  // created -> claimed -> in_progress -> done is four stamps; the page keeps
  // the newest three and counts the dropped one.
  assert.equal(done.history.length, 3);
  assert.equal(done.historyOmitted, 1);
});

test("limit is honored and echoed, up to the 200 cap", async t => {
  const { get } = await serve(t, seedBoard);
  assert.equal((await (await get("?limit=1")).json()).limit, 1);
  assert.equal((await (await get("?limit=200")).json()).limit, 200);
});

test("state filters scope the page and stamp it", async t => {
  const { get } = await serve(t, seedBoard);
  const body = await (await get("?state=done")).json();
  assert.equal(body.state, "done");
  assert.equal(body.historyScope, "state");
  assert.ok(body.claims.length > 0);
  assert.ok(body.claims.every(claim => claim.state === "done"));
});

test("queue=ready lists unclaimed ownerless claims", async t => {
  const { get } = await serve(t, seedBoard);
  const body = await (await get("?queue=ready")).json();
  assert.equal(body.queue, "ready");
  assert.equal(body.historyScope, "ready");
  assert.ok(body.claims.some(claim => claim.id === "ready-1"));
  assert.ok(body.claims.every(claim => claim.state === "unclaimed" && !claim.owner));
});

// --- error cases ---

test("bad limits are rejected with 422 invalid_claim_input", async t => {
  const { get } = await serve(t, seedBoard);
  for (const query of ["?limit=0", "?limit=201", "?limit=abc", "?limit=2&limit=3"]) {
    const err = await errorOf(await get(query));
    assert.equal(err.status, 422, query);
    assert.equal(err.code, "invalid_claim_input", query);
    assert.match(err.message, /Expected/, query);
  }
});

test("bad state and queue combinations are rejected with 422", async t => {
  const { get } = await serve(t, seedBoard);
  for (const query of ["?state=nope", "?queue=nope", "?queue=ready&state=claimed", "?bogus=1"]) {
    const err = await errorOf(await get(query));
    assert.equal(err.status, 422, query);
    assert.equal(err.code, "invalid_claim_input", query);
  }
});

test("a malformed cursor is rejected with 422", async t => {
  const { get } = await serve(t, seedBoard);
  const err = await errorOf(await get("?cursor=not-a-cursor"));
  assert.equal(err.status, 422);
  assert.equal(err.code, "invalid_claim_input");
});

test("queue cursors and page cursors do not cross", async t => {
  const { get } = await serve(t, seedBoard);
  const queueCursor = cursorOf({ q: "ready", i: "ready-1" });
  const pageCursor = cursorOf({ u: new Date().toISOString(), i: "done-1" });
  const onDefault = await errorOf(await get(`?cursor=${queueCursor}`));
  assert.equal(onDefault.status, 422);
  assert.equal(onDefault.code, "invalid_claim_input");
  const onQueue = await errorOf(await get(`?queue=ready&cursor=${pageCursor}`));
  assert.equal(onQueue.status, 422);
  assert.equal(onQueue.code, "invalid_claim_input");
});

test("cursors bind the state filter they were issued under", async t => {
  const now = Date.now();
  const { get } = await serve(t, store => {
    const put = item => store.workClaims.set("commons", item);
    for (const [id, at] of [["c-bound-1", now - 3 * H], ["c-bound-2", now - 2 * H]]) {
      put(claimWork(createWork({ id, title: id }, { now: at - H }), "owner", { now: at }));
    }
  });
  const first = await (await get("?state=claimed&limit=1")).json();
  assert.ok(first.nextCursor, "a second page exists");
  const sameState = await get(`?state=claimed&cursor=${first.nextCursor}`);
  assert.equal(sameState.status, 200, "same-state continuation works");
  const crossState = await errorOf(await get(`?state=done&cursor=${first.nextCursor}`));
  assert.equal(crossState.status, 422);
  assert.equal(crossState.code, "invalid_claim_input");
});

test("pagination walks the board with opaque cursors", async t => {
  const now = Date.now();
  const { get } = await serve(t, store => {
    const put = item => store.workClaims.set("commons", item);
    for (const [id, at] of [["c-page-1", now - 3 * H], ["c-page-2", now - 2 * H], ["c-page-3", now - H]]) {
      put(claimWork(createWork({ id, title: id }, { now: at - H }), "owner", { now: at }));
    }
  });
  const first = await (await get("?limit=2")).json();
  assert.equal(first.claims.length, 2);
  assert.equal(first.hasMore, true);
  assert.equal(typeof first.nextCursor, "string");
  const second = await (await get(`?limit=2&cursor=${first.nextCursor}`)).json();
  assert.equal(second.claims.length, 1);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);
  const seen = new Set([...first.claims, ...second.claims].map(claim => claim.id));
  assert.deepEqual([...seen].sort(), ["c-page-1", "c-page-2", "c-page-3"]);
});

// --- read without housekeeping ---

test("an expired lease is still listed as claimed: this route sweeps nothing", async t => {
  const now = Date.now();
  const { store, get } = await serve(t, st => {
    const created = createWork({ id: "expiring-1", title: "expiring one" }, { now: now - 2 * H });
    st.workClaims.set("commons", claimWork(created, "owner", { now: now - 2 * H, leaseHours: 1 }));
  });
  const stored = store.workClaims.get("commons", "expiring-1");
  assert.ok(Date.parse(stored.leaseExpiresAt) < Date.now(), "the lease is genuinely expired");
  const body = await (await get()).json();
  const claim = body.claims.find(item => item.id === "expiring-1");
  assert.ok(claim, "the claim is still projected");
  assert.equal(claim.state, "claimed", "no auto-release on the read-only route");
  assert.equal(claim.owner, "owner");
});

// --- default done window ---

test("the default page keeps recent done claims and counts older ones", async t => {
  const now = Date.now();
  const { get } = await serve(t, store => {
    const put = item => store.workClaims.set("commons", item);
    const doneAt = (id, at) => {
      let item = createWork({ id, title: id }, { now: at - 3 * H });
      item = claimWork(item, "owner", { now: at - 2 * H });
      item = updateWork(item, "owner", { state: "in_progress", now: at - H });
      return updateWork(item, "owner", { state: "done", now: at });
    };
    put(doneAt("recent-done", now - DAY));
    put(doneAt("old-done", now - 8 * DAY));
  });
  const body = await (await get()).json();
  const ids = body.claims.map(claim => claim.id);
  assert.ok(ids.includes("recent-done"), "recent done claims stay visible");
  assert.ok(!ids.includes("old-done"), "done claims older than seven days drop out");
  assert.equal(body.olderDone, 1);
  assert.equal(body.olderDoneQuery, "state=done");
  const all = await (await get("?state=done")).json();
  assert.ok(all.claims.some(claim => claim.id === "old-done"), "state=done lists every done claim");
});
