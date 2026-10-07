// HTTP contract tests for the unmounted session-lifecycle routes
// (server/session-lifecycle-routes.mjs, herdr B14).
//
// The domain module (server/session-lifecycle.mjs) is covered by
// tests/session-lifecycle.test.js; that file imports these routes but never
// invokes handleSessionLifecycle, so the entire HTTP boundary — route
// dispatch, method enforcement, auth/ownership, body-shape validation, and
// the domain-error → HTTP status mapping — would otherwise ship at 0%
// behavioral coverage. These tests own that boundary with a fake lifecycle
// (the handler already accepts one via the `lifecycle` param) and the
// repo-standard fake helpers.

import test from "node:test";
import assert from "node:assert/strict";
import { handleSessionLifecycle, } from "../server/session-lifecycle-routes.mjs";
import { SessionLifecycleError, } from "../server/session-lifecycle.mjs";

const fakeHelpers = () => {
  const calls = [];
  const reject = (status, code, message) => {
    const error = new Error(message); error.status = status; error.code = code; throw error;
  };
  const json = (res, status, value) => { calls.push({ status, value }); return { status, value }; };
  return { calls, json, reject, body: async req => req.body };
};

const SESSION = {
  sessionId: "sess-1", laneMemberId: "quill", tenantId: "t1",
  kind: "worker", state: "active", duplicate: false,
};

const fakeLifecycle = (overrides = {}) => ({
  spawnSession: async args => ({ ...SESSION, duplicate: false, spawned: args }),
  listSessions: async args => ({ sessions: [SESSION], queried: args }),
  getSession: async id => { if (id !== SESSION.sessionId) throw new SessionLifecycleError(404, "session_not_found", `no session ${id}`); return { ...SESSION }; },
  sessionJournal: async (id, opts) => ({ entries: [], journalOpts: opts }),
  attachSession: async args => ({ ...SESSION, attached: args }),
  heartbeatSession: async args => ({ ok: true, beat: args }),
  detachSession: async args => ({ ...SESSION, state: "detached" }),
  reattachSession: async args => ({ ...SESSION, state: "active" }),
  suspendSession: async args => ({ ...SESSION, state: "suspended" }),
  resumeSession: async args => ({ ...SESSION, state: "active" }),
  destroySession: async args => ({ ...SESSION, state: "destroyed" }),
  ...overrides,
});

const runRoute = async ({ route, id = null, method = "POST", body = {}, memberId = "quill", lifecycle = null, search = "" }) => {
  const helpers = fakeHelpers();
  const lc = lifecycle ?? fakeLifecycle();
  const url = new URL(`http://x/api/rooms/room1/herdr-sessions${search}`);
  try {
    const out = await handleSessionLifecycle({
      req: { method, body }, res: {}, url, store: {}, roomId: "room1",
      auth: memberId ? { member: { id: memberId } } : {},
      lifecycleRoute: route, lifecycleId: id, helpers, lifecycle: lc,
    });
    return { out, error: null, calls: helpers.calls, lifecycle: lc };
  } catch (error) {
    return { out: null, error, calls: helpers.calls, lifecycle: lc };
  }
};

const CREATE_BODY = {
  idempotencyKey: "idem-1", claimId: "claim-1",
  laneMemberId: "quill", tenantId: "t1", kind: "worker",
};

test("create: valid POST returns 201 and spawns with the merged room", async () => {
  const { out, error } = await runRoute({ route: "create", body: CREATE_BODY });
  assert.equal(error, null);
  assert.equal(out.status, 201);
  assert.equal(out.value.session.sessionId, "sess-1");
  assert.equal(out.value.session.spawned.roomId, "room1");
  assert.equal(out.value.roomId, "room1");
});

test("create: idempotent duplicate returns 200", async () => {
  const lc = fakeLifecycle({ spawnSession: async () => ({ ...SESSION, duplicate: true }) });
  const { out, error } = await runRoute({ route: "create", body: CREATE_BODY, lifecycle: lc });
  assert.equal(error, null);
  assert.equal(out.status, 200);
});

test("create: wrong method is 405", async () => {
  const { error } = await runRoute({ route: "create", method: "GET", body: CREATE_BODY });
  assert.equal(error.status, 405);
  assert.equal(error.code, "method_not_allowed");
});

test("create: malformed body is 422", async () => {
  const { error } = await runRoute({ route: "create", body: { idempotencyKey: "x" } });
  assert.equal(error.status, 422);
  assert.equal(error.code, "invalid_lifecycle_input");
});

test("create: laneMemberId must equal the caller", async () => {
  const { error } = await runRoute({ route: "create", body: { ...CREATE_BODY, laneMemberId: "grok" } });
  assert.equal(error.status, 403);
  assert.equal(error.code, "session_not_owner");
});

test("routes require authentication", async () => {
  const { error } = await runRoute({ route: "list", method: "GET", memberId: null });
  assert.equal(error.status, 401);
  assert.equal(error.code, "lifecycle_unauthorized");
});

test("list: GET returns caller-scoped sessions", async () => {
  const { out, error } = await runRoute({ route: "list", method: "GET" });
  assert.equal(error, null);
  assert.equal(out.status, 200);
  assert.equal(out.value.sessions[0].sessionId, "sess-1");
  assert.equal(out.value.queried.laneMemberId, "quill");
});

test("list: reads are caller-scoped even with an explicit laneMemberId", async () => {
  const { error } = await runRoute({ route: "list", method: "GET", search: "?laneMemberId=grok" });
  assert.equal(error.status, 403);
  assert.equal(error.code, "session_not_owner");
});

test("list: bad limit is 422", async () => {
  const { error } = await runRoute({ route: "list", method: "GET", search: "?limit=999" });
  assert.equal(error.status, 422);
  assert.equal(error.code, "invalid_lifecycle_input");
});

test("item: GET returns the owned session", async () => {
  const { out, error } = await runRoute({ route: "item", method: "GET", id: "sess-1" });
  assert.equal(error, null);
  assert.equal(out.status, 200);
  assert.equal(out.value.session.sessionId, "sess-1");
});

test("item: another member's session is 403", async () => {
  const lc = fakeLifecycle({ getSession: async () => ({ ...SESSION, laneMemberId: "grok" }) });
  const { error } = await runRoute({ route: "item", method: "GET", id: "sess-1", lifecycle: lc });
  assert.equal(error.status, 403);
  assert.equal(error.code, "session_not_owner");
});

test("item: unknown session maps the domain 404", async () => {
  const { error } = await runRoute({ route: "item", method: "GET", id: "nope" });
  assert.equal(error.status, 404);
  assert.equal(error.code, "session_not_found");
});

test("journal: GET returns entries with validated pagination", async () => {
  const { out, error } = await runRoute({ route: "journal", method: "GET", id: "sess-1", search: "?limit=10&after=5" });
  assert.equal(error, null);
  assert.equal(out.status, 200);
  assert.deepEqual(out.value.journalOpts, { limit: 10, after: 5 });
});

test("journal: bad limit is 422", async () => {
  const { error } = await runRoute({ route: "journal", method: "GET", id: "sess-1", search: "?limit=0" });
  assert.equal(error.status, 422);
});

const ACTION_CASES = [
  ["attach", { idempotencyKey: "i1", claimId: "claim-1" }],
  ["heartbeat", { occupantId: "occ-1", idempotencyKey: "i2" }],
  ["detach", { idempotencyKey: "i3", reason: "done" }],
  ["reattach", { idempotencyKey: "i4" }],
  ["suspend", { idempotencyKey: "i5", reason: "pause" }],
  ["resume", { idempotencyKey: "i6" }],
  ["destroy", { idempotencyKey: "i7", reason: "cleanup" }],
];

for (const [route, body] of ACTION_CASES) {
  test(`${route}: POST drives the owned session`, async () => {
    const { out, error } = await runRoute({ route, id: "sess-1", body });
    assert.equal(error, null);
    assert.equal(out.status, 200);
  });
  test(`${route}: wrong method is 405`, async () => {
    const { error } = await runRoute({ route, id: "sess-1", method: "GET", body });
    assert.equal(error.status, 405);
  });
  test(`${route}: malformed body is 422`, async () => {
    const { error } = await runRoute({ route, id: "sess-1", body: {} });
    assert.equal(error.status, 422);
    assert.equal(error.code, "invalid_lifecycle_input");
  });
}

test("unknown route is 404", async () => {
  const { error } = await runRoute({ route: "teleport", id: "sess-1", body: {} });
  assert.equal(error.status, 404);
  assert.equal(error.code, "lifecycle_unknown_route");
});

test("domain errors map to their HTTP status and code", async () => {
  const lc = fakeLifecycle({
    getSession: async () => { throw new SessionLifecycleError(409, "session_occupant_changed", "taken"); },
  });
  const { error } = await runRoute({ route: "item", method: "GET", id: "sess-1", lifecycle: lc });
  assert.equal(error.status, 409);
  assert.equal(error.code, "session_occupant_changed");
});

test("named transport/domain errors map per D2 §2.9", async () => {
  const mkErr = name => { const e = new Error(name); e.name = name; return e; };
  const cases = [
    ["VersionMismatchError", 503, "herdr_version_mismatch"],
    ["OccupantChangedError", 409, "session_occupant_changed"],
    ["TimeoutError", 504, "herdr_timeout"],
    ["ServerError", 500, "herdr_server_error"],
  ];
  for (const [name, status, code] of cases) {
    const lc = fakeLifecycle({ getSession: async () => { throw mkErr(name); } });
    const { error } = await runRoute({ route: "item", method: "GET", id: "sess-1", lifecycle: lc });
    assert.equal(error.status, status, name);
    assert.equal(error.code, code, name);
  }
});
