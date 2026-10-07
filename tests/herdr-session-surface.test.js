// B16: herdr session state surfacing in existing room views (flag-gated, additive).
//
// Contracts under test:
//  1. ROOM_HERDR_SESSIONS parsing: unset/"off"/garbage -> disabled (fail-closed);
//     "on" -> every room; "=r1,r2" -> only listed rooms.
//  2. Conjunction rule: a session surfaces only when the flag covers the room AND
//     the lane opted in (herdr_lane_optin, sessionBackend "herdr") AND a
//     non-terminal herdr_sessions row exists. Missing tables -> null (B5 not
//     landed yet must read as "no sessions", never throw).
//  3. Presence entries omit `herdrSession` when there is nothing to show, so a
//     flag-off response is byte-identical to the pre-herdr shape.
//  4. Work-claim list/read responses carry `herdrSession` only for claims with a
//     linked live session; otherwise the claim object is returned untouched.
//  5. The client chip renders escaped HTML, or "" when there is no session.
//
// Test-audit gate: (1) these guard the Phase-A "flag off = provably the old
// binary" invariant and the opt-in conjunction rule from the migration rollout
// doc — no existing test covers any herdr path; (2) credible regressions are a
// truthy flag check ("off" enabling the badge), a dropped opt-in check (session
// state leaking to non-opted-in lanes), and unescaped state in HTML; (3) no
// production seam exists only for tests — the parser, store method, and chip
// helper are all called from production paths.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore, parseHerdrSessionsFlag } from "../server/store.mjs";
import { herdrSessionChip } from "../src/presence-state.js";
import { initialRoom } from "../server/bootstrap.mjs";
import { createWork, claimWork } from "../server/work-claims.mjs";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// 1. Flag parsing
// ---------------------------------------------------------------------------

test("parseHerdrSessionsFlag: unset/empty/off-like values disable", () => {
  for (const raw of [undefined, null, "", "  ", "off", "OFF", " Off ", "0", "false", "no"]) {
    assert.deepEqual(parseHerdrSessionsFlag(raw), { enabled: false, rooms: null }, `raw=${JSON.stringify(raw)}`);
  }
});

test("parseHerdrSessionsFlag: on-like values enable globally", () => {
  for (const raw of ["on", "ON", " On ", "1", "true", "yes"]) {
    assert.deepEqual(parseHerdrSessionsFlag(raw), { enabled: true, rooms: null }, `raw=${JSON.stringify(raw)}`);
  }
});

test("parseHerdrSessionsFlag: =r1,r2 enables for listed rooms only", () => {
  assert.deepEqual(parseHerdrSessionsFlag("=room-a,room-b"), { enabled: true, rooms: ["room-a", "room-b"] });
  assert.deepEqual(parseHerdrSessionsFlag("= room-a , room-b "), { enabled: true, rooms: ["room-a", "room-b"] });
});

test("parseHerdrSessionsFlag: garbage fails closed", () => {
  for (const raw of ["maybe", "=", "=,", "onwards", "enabled"]) {
    assert.deepEqual(parseHerdrSessionsFlag(raw), { enabled: false, rooms: null }, `raw=${JSON.stringify(raw)}`);
  }
});

// ---------------------------------------------------------------------------
// Store fixture: real SQLite, B5 tables seeded by hand (B5 has not landed).
// ---------------------------------------------------------------------------

const B5_DDL = `
  CREATE TABLE herdr_lane_optin (
    room_id TEXT NOT NULL, lane_member_id TEXT NOT NULL,
    session_backend TEXT NOT NULL, set_by TEXT, set_at TEXT
  );
  CREATE TABLE herdr_sessions (
    session_id TEXT NOT NULL, room_id TEXT NOT NULL, claim_id TEXT,
    lane_member_id TEXT NOT NULL, state TEXT NOT NULL, backend TEXT NOT NULL,
    pane_id TEXT, updated_at TEXT, created_at TEXT
  );
`;

function serve(t, herdrSessions) {
  const directory = mkdtempSync(join(tmpdir(), "room-herdr-surface-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { herdrSessions });
  store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function seedB5(store, { optins = [], sessions = [] } = {}) {
  store.db.exec(B5_DDL);
  const optin = store.db.prepare(
    "INSERT INTO herdr_lane_optin (room_id, lane_member_id, session_backend, set_by, set_at) VALUES (?,?,?,?,?)");
  for (const o of optins) optin.run("commons", o.memberId, o.backend ?? "herdr", "owner", new Date(0).toISOString());
  const session = store.db.prepare(
    "INSERT INTO herdr_sessions (session_id, room_id, claim_id, lane_member_id, state, backend, pane_id, updated_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)");
  for (const s of sessions) {
    session.run(s.sessionId, "commons", s.claimId ?? null, s.memberId, s.state,
      "herdr", s.paneId ?? null, s.updatedAt ?? new Date(0).toISOString(), new Date(0).toISOString());
  }
}

function addAgent(store, ownerKey, memberId = "agent1") {
  store.command(ownerKey, "commons", {
    id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId, displayName: "Agent One", kind: "agent", permissions: ["accept_work", "complete_work"] },
  });
}

// ---------------------------------------------------------------------------
// 2. herdrSessionsForRoom: the conjunction rule + fail-closed reads
// ---------------------------------------------------------------------------

test("herdrSessionsForRoom: null when the flag is off even with tables seeded", t => {
  const store = serve(t, "off");
  seedB5(store, {
    optins: [{ memberId: "agent1" }],
    sessions: [{ sessionId: "ses-1", memberId: "agent1", claimId: "c1", state: "active" }],
  });
  assert.equal(store.herdrSessionsForRoom("commons"), null);
});

test("herdrSessionsForRoom: null when B5 tables are absent (fail-closed)", t => {
  const store = serve(t, "on");
  assert.equal(store.herdrSessionsForRoom("commons"), null);
});

test("herdrSessionsForRoom: active session surfaces for an opted-in lane", t => {
  const store = serve(t, "on");
  seedB5(store, {
    optins: [{ memberId: "agent1" }],
    sessions: [{ sessionId: "ses-1", memberId: "agent1", claimId: "c1", state: "active" }],
  });
  const found = store.herdrSessionsForRoom("commons");
  assert.ok(found);
  assert.deepEqual(found.byMember.get("agent1"), { state: "active", sessionId: "ses-1", claimId: "c1" });
  assert.deepEqual(found.byClaim.get("c1"), { state: "active", sessionId: "ses-1", laneMemberId: "agent1" });
  assert.equal(found.byMember.get("owner"), undefined);
});

test("herdrSessionsForRoom: no opt-in row means no surfacing (conjunction rule)", t => {
  const store = serve(t, "on");
  seedB5(store, {
    sessions: [{ sessionId: "ses-1", memberId: "agent1", claimId: "c1", state: "active" }],
  });
  assert.equal(store.herdrSessionsForRoom("commons"), null);
});

test("herdrSessionsForRoom: explicit legacy opt-in means no surfacing", t => {
  const store = serve(t, "on");
  seedB5(store, {
    optins: [{ memberId: "agent1", backend: "legacy" }],
    sessions: [{ sessionId: "ses-1", memberId: "agent1", claimId: "c1", state: "active" }],
  });
  assert.equal(store.herdrSessionsForRoom("commons"), null);
});

test("herdrSessionsForRoom: destroyed sessions never surface", t => {
  const store = serve(t, "on");
  seedB5(store, {
    optins: [{ memberId: "agent1" }],
    sessions: [{ sessionId: "ses-1", memberId: "agent1", claimId: "c1", state: "destroyed" }],
  });
  const found = store.herdrSessionsForRoom("commons");
  assert.ok(found);
  assert.equal(found.byMember.get("agent1"), undefined);
  assert.equal(found.byClaim.get("c1"), undefined);
});

test("herdrSessionsForRoom: room-scoped flag hides unlisted rooms", t => {
  const store = serve(t, "=other-room");
  seedB5(store, {
    optins: [{ memberId: "agent1" }],
    sessions: [{ sessionId: "ses-1", memberId: "agent1", claimId: "c1", state: "active" }],
  });
  assert.equal(store.herdrSessionsForRoom("commons"), null);
});

test("herdrSessionsForRoom: latest session row wins per member", t => {
  const store = serve(t, "on");
  seedB5(store, {
    optins: [{ memberId: "agent1" }],
    sessions: [
      { sessionId: "ses-old", memberId: "agent1", claimId: "c0", state: "active", updatedAt: "2026-10-01T00:00:00.000Z" },
      { sessionId: "ses-new", memberId: "agent1", claimId: "c1", state: "detached", updatedAt: "2026-10-06T00:00:00.000Z" },
    ],
  });
  const found = store.herdrSessionsForRoom("commons");
  assert.equal(found.byMember.get("agent1")?.sessionId, "ses-new");
  assert.equal(found.byMember.get("agent1")?.state, "detached");
});

// ---------------------------------------------------------------------------
// 3. presence(): additive, omitted-when-null
// ---------------------------------------------------------------------------

test("presence: flag off leaves entries byte-identical (no herdrSession key)", t => {
  const store = serve(t, "off");
  const ownerKey = store.issueAccessKey("commons", "owner");
  addAgent(store, ownerKey);
  seedB5(store, {
    optins: [{ memberId: "agent1" }],
    sessions: [{ sessionId: "ses-1", memberId: "agent1", claimId: "c1", state: "active" }],
  });
  const { members } = store.presence(ownerKey, "commons", []);
  for (const m of members) assert.ok(!("herdrSession" in m), `member ${m.memberId} leaked a key`);
});

test("presence: opted-in lane entry carries herdrSession; others omit the key", t => {
  const store = serve(t, "on");
  const ownerKey = store.issueAccessKey("commons", "owner");
  addAgent(store, ownerKey);
  seedB5(store, {
    optins: [{ memberId: "agent1" }],
    sessions: [{ sessionId: "ses-1", memberId: "agent1", claimId: "c1", state: "active" }],
  });
  const { members } = store.presence(ownerKey, "commons", []);
  const agent = members.find(m => m.memberId === "agent1");
  const owner = members.find(m => m.memberId === "owner");
  assert.deepEqual(agent.herdrSession, { state: "active", sessionId: "ses-1", claimId: "c1" });
  assert.ok(!("herdrSession" in owner));
});

// ---------------------------------------------------------------------------
// 4. work-claims list/read: per-claim indicator, additive
// ---------------------------------------------------------------------------

const fakeHelpers = () => {
  const calls = [];
  const reject = (status, code, message) => {
    const error = new Error(message); error.status = status; error.code = code; throw error;
  };
  const json = (res, status, value) => { calls.push({ status, value }); return { status, value }; };
  return { calls, json, reject, body: async req => req.body };
};

function claimRegistryWith(store) {
  const registry = createWorkClaimRegistry();
  const created = createWork({ id: "c1", title: "linked work" });
  registry.set("commons", claimWork(created, "agent1", { leaseHours: 6, now: Date.now() }));
  const created2 = createWork({ id: "c2", title: "plain work" });
  registry.set("commons", claimWork(created2, "agent1", { leaseHours: 6, now: Date.now() }));
  return registry;
}

test("work-claims list: linked claim carries herdrSession; unlinked claim untouched", async t => {
  const store = serve(t, "on");
  seedB5(store, {
    optins: [{ memberId: "agent1" }],
    sessions: [{ sessionId: "ses-1", memberId: "agent1", claimId: "c1", state: "active" }],
  });
  const registry = claimRegistryWith(store);
  const helpers = fakeHelpers();
  const out = await handleWorkClaims({
    req: { method: "GET" }, res: {}, url: new URL("http://x/api/rooms/commons/work-claims"),
    store, roomId: "commons", auth: { member: { id: "owner" } },
    workClaimRoute: "list", workClaimId: null, helpers, registry,
  });
  const byId = Object.fromEntries(out.value.claims.map(c => [c.id, c]));
  assert.deepEqual(byId.c1.herdrSession, { state: "active", sessionId: "ses-1", laneMemberId: "agent1" });
  assert.ok(!("herdrSession" in byId.c2), "unlinked claim must be untouched");
});

test("work-claims list: flag off returns claims untouched", async t => {
  const store = serve(t, "off");
  seedB5(store, {
    optins: [{ memberId: "agent1" }],
    sessions: [{ sessionId: "ses-1", memberId: "agent1", claimId: "c1", state: "active" }],
  });
  const registry = claimRegistryWith(store);
  const helpers = fakeHelpers();
  const out = await handleWorkClaims({
    req: { method: "GET" }, res: {}, url: new URL("http://x/api/rooms/commons/work-claims"),
    store, roomId: "commons", auth: { member: { id: "owner" } },
    workClaimRoute: "list", workClaimId: null, helpers, registry,
  });
  for (const c of out.value.claims) assert.ok(!("herdrSession" in c), `claim ${c.id} leaked a key`);
});

test("work-claims read: linked claim carries herdrSession", async t => {
  const store = serve(t, "on");
  seedB5(store, {
    optins: [{ memberId: "agent1" }],
    sessions: [{ sessionId: "ses-1", memberId: "agent1", claimId: "c1", state: "suspended" }],
  });
  const registry = claimRegistryWith(store);
  const helpers = fakeHelpers();
  const out = await handleWorkClaims({
    req: { method: "GET" }, res: {}, url: new URL("http://x/api/rooms/commons/work-claims/c1"),
    store, roomId: "commons", auth: { member: { id: "owner" } },
    workClaimRoute: "read", workClaimId: "c1", helpers, registry,
  });
  assert.deepEqual(out.value.herdrSession, { state: "suspended", sessionId: "ses-1", laneMemberId: "agent1" });
});

// ---------------------------------------------------------------------------
// 5. Client chip
// ---------------------------------------------------------------------------

test("herdrSessionChip: empty without a session", () => {
  assert.equal(herdrSessionChip(null), "");
  assert.equal(herdrSessionChip(undefined), "");
  assert.equal(herdrSessionChip({}), "");
  assert.equal(herdrSessionChip({ state: "" }), "");
});

test("herdrSessionChip: renders an escaped badge", () => {
  const html = herdrSessionChip({ state: "active" });
  assert.match(html, /herdr-session-chip/);
  assert.match(html, /data-herdr-state="active"/);
  assert.match(html, /herdr · active/);
});

test("herdrSessionChip: escapes hostile state strings", () => {
  const html = herdrSessionChip({ state: '"><script>alert(1)</script>' });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&quot;&gt;&lt;script&gt;/);
});
