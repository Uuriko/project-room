// FIX-59: /presence fast modes — ?fields= field selection, ?count=1 count-only,
// ?limit/?offset pagination. All opt-in; the default response shape is unchanged.
//
// Fail-first: on the pre-fix tree these fail because store.presence() ignores
// the options (countOnly returns {members,next}, fields are ignored, limit is
// ignored, invalid params are not rejected).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const FULL_FIELDS = [
  "memberId", "displayName", "kind", "watching", "workingOn", "lastSeenAt",
  "statusMessage", "presence", "state", "isOwner", "scopes",
  "ownerIdentityId", "cardAgentId",
];

// ---------------------------------------------------------------------------
// Small fixture: HTTP shape + validation tests (fast).
// ---------------------------------------------------------------------------

async function serveHttp(t, memberCount = 5) {
  const directory = mkdtempSync(join(tmpdir(), "room-presence-fast-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  for (let i = 0; i < memberCount; i++) {
    store.command(ownerKey, "commons", {
      id: randomUUID(), type: T.MEMBER_ADDED,
      data: {
        memberId: `m${i}`, displayName: `Member ${i}`,
        kind: i % 2 ? "agent" : "human", permissions: [],
      },
    });
  }
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (path, token = ownerKey) => fetch(origin + path, {
    headers: { Origin: origin, Authorization: `Bearer ${token}` },
  });
  return { store, get, memberTotal: memberCount + 1 /* owner */ };
}

test("HTTP: default presence shape is unchanged (no new keys, full fields)", async t => {
  const { get, memberTotal } = await serveHttp(t);
  const res = await get("/api/rooms/commons/presence");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ["members", "next"]);
  assert.equal(body.members.length, memberTotal);
  for (const m of body.members) {
    assert.deepEqual(Object.keys(m).sort(), [...FULL_FIELDS].sort());
  }
  // Sorted by memberId (existing contract).
  const ids = body.members.map(m => m.memberId);
  assert.deepEqual(ids, [...ids].sort());
});

test("HTTP: ?count=1 returns only the member count", async t => {
  const { get, memberTotal } = await serveHttp(t);
  const res = await get("/api/rooms/commons/presence?count=1");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { memberCount: memberTotal });
});

test("HTTP: ?count=1 takes precedence over fields/limit", async t => {
  const { get, memberTotal } = await serveHttp(t);
  const res = await get("/api/rooms/commons/presence?count=1&fields=memberId&limit=2");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { memberCount: memberTotal });
});

test("HTTP: ?fields= selects a subset of member fields", async t => {
  const { get } = await serveHttp(t);
  const res = await get("/api/rooms/commons/presence?fields=memberId,displayName,kind");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ["members", "next"]);
  assert.ok(body.members.length > 0);
  for (const m of body.members) {
    assert.deepEqual(Object.keys(m).sort(), ["displayName", "kind", "memberId"]);
  }
});

test("HTTP: ?fields= with an unknown field is rejected", async t => {
  const { get } = await serveHttp(t);
  const res = await get("/api/rooms/commons/presence?fields=memberId,nope");
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error.code, "invalid_presence_fields");
});

test("HTTP: ?fields= empty is rejected", async t => {
  const { get } = await serveHttp(t);
  for (const q of ["?fields=", "?fields=,"]) {
    const res = await get(`/api/rooms/commons/presence${q}`);
    assert.equal(res.status, 422, q);
    assert.equal((await res.json()).error.code, "invalid_presence_fields", q);
  }
});

test("HTTP: ?limit/?offset paginate and report total", async t => {
  const { get, memberTotal } = await serveHttp(t, 9); // 10 members total
  const full = await (await get("/api/rooms/commons/presence")).json();
  const res = await get("/api/rooms/commons/presence?limit=3&offset=4");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.members.length, 3);
  assert.equal(body.total, memberTotal);
  assert.deepEqual(
    body.members.map(m => m.memberId),
    full.members.slice(4, 7).map(m => m.memberId),
  );
  // Offset past the end: empty page, total still reported.
  const tail = await (await get(`/api/rooms/commons/presence?limit=3&offset=${memberTotal}`)).json();
  assert.deepEqual(tail.members, []);
  assert.equal(tail.total, memberTotal);
});

test("HTTP: bad pagination values are rejected", async t => {
  const { get } = await serveHttp(t);
  for (const q of ["?limit=0", "?limit=-2", "?limit=abc", "?limit=1.5", "?limit=1001", "?offset=-1", "?offset=2.5"]) {
    const res = await get(`/api/rooms/commons/presence${q}`);
    assert.equal(res.status, 422, q);
    assert.equal((await res.json()).error.code, "invalid_presence_pagination", q);
  }
});

test("HTTP: unknown query params are rejected", async t => {
  const { get } = await serveHttp(t);
  const res = await get("/api/rooms/commons/presence?bogus=1");
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error.code, "invalid_presence_params");
});

test("HTTP: bad ?count= values are rejected", async t => {
  const { get, memberTotal } = await serveHttp(t);
  const res = await get("/api/rooms/commons/presence?count=2");
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error.code, "invalid_presence_count");
  // count=0 is explicitly "off": full shape, not count mode.
  const off = await (await get("/api/rooms/commons/presence?count=0")).json();
  assert.ok(Array.isArray(off.members));
  assert.equal(off.members.length, memberTotal);
});

// ---------------------------------------------------------------------------
// Busy fixture: store-level timing tests (slow path vs fast modes).
// ---------------------------------------------------------------------------

const BUSY_MEMBERS = 40;
const BUSY_EVENTS = 40000;

function serveBusy(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-presence-busy-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  for (let i = 0; i < BUSY_MEMBERS; i++) {
    store.command(ownerKey, "commons", {
      id: randomUUID(), type: T.MEMBER_ADDED,
      data: {
        memberId: `m${i}`, displayName: `Member ${i}`,
        kind: i % 2 ? "agent" : "human", permissions: [],
      },
    });
  }
  // Raw event rows (bypass the command pipeline for setup speed). The
  // lastCommandAt GROUP BY scan in presence() reads this table directly.
  const maxSeq = store.db.prepare(
    "SELECT COALESCE(MAX(sequence),0) AS s FROM events WHERE room_id='commons'").get().s;
  const now = Date.now();
  const ins = store.db.prepare(
    "INSERT INTO events(room_id, sequence, id, body) VALUES('commons', ?, ?, ?)");
  store.db.exec("BEGIN");
  for (let i = 0; i < BUSY_EVENTS; i++) {
    const actor = `m${i % BUSY_MEMBERS}`;
    const at = now - (i % 5000) * 1000;
    const type = i % 97 === 0 ? "member.added" : "message.posted";
    const data = type === "member.added" ? `,"data":{"memberId":"${actor}"}` : `,"data":{}`;
    ins.run(maxSeq + 1 + i, `e${i}`,
      `{"id":"e${i}","type":"${type}","at":${at},"actorId":"${actor}"${data}}`);
  }
  store.db.exec("COMMIT");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, ownerKey };
}

const timeIt = fn => { const a = Date.now(); const out = fn(); return { ms: Date.now() - a, out }; };

test("store: legacy 4-arg session-binding signature still works", t => {
  const { store, ownerKey } = serveBusy(t);
  const body = store.presence(ownerKey, "commons", [], null);
  assert.equal(body.members.length, BUSY_MEMBERS + 1);
  assert.deepEqual(Object.keys(body).sort(), ["members", "next"]);
  assert.deepEqual(Object.keys(body.members[0]).sort(), [...FULL_FIELDS].sort());
});

test("store: options object accepted as 4th arg (bindingOrOptions)", t => {
  const { store, ownerKey } = serveBusy(t);
  const body = store.presence(ownerKey, "commons", [], { countOnly: true });
  assert.deepEqual(body, { memberCount: BUSY_MEMBERS + 1 });
});

test("store: countOnly is fast and the slow path stays slow (relative)", t => {
  const { store, ownerKey } = serveBusy(t);
  store.presence(ownerKey, "commons", []); // warm projection cache
  const full = timeIt(() => store.presence(ownerKey, "commons", []));
  const counted = timeIt(() => store.presence(ownerKey, "commons", [], { countOnly: true }));
  assert.deepEqual(counted.out, { memberCount: BUSY_MEMBERS + 1 });
  // Generous absolute ceiling for the fast mode (CI-safe).
  assert.ok(counted.ms < 5000, `countOnly took ${counted.ms}ms`);
  // The slow path still does the full event-table scan: it must remain
  // clearly slower than the fast mode on the same data.
  assert.ok(full.ms > counted.ms,
    `slow path ${full.ms}ms should exceed countOnly ${counted.ms}ms`);
  console.log(`    [timing] full=${full.ms}ms countOnly=${counted.ms}ms`);
});

test("store: slim ?fields= skips the expensive scans", t => {
  const { store, ownerKey } = serveBusy(t);
  store.presence(ownerKey, "commons", []); // warm projection cache
  const full = timeIt(() => store.presence(ownerKey, "commons", []));
  const slim = timeIt(() => store.presence(ownerKey, "commons", [], {
    fields: ["memberId", "displayName", "kind", "watching"],
  }));
  for (const m of slim.out.members) {
    assert.deepEqual(Object.keys(m).sort(), ["displayName", "kind", "memberId", "watching"]);
  }
  assert.equal(slim.out.members.length, BUSY_MEMBERS + 1);
  assert.ok(slim.ms < 5000, `slim fields took ${slim.ms}ms`);
  // 3x margin: slim skips both event-table scans and host lookups.
  assert.ok(slim.ms * 3 < full.ms,
    `slim ${slim.ms}ms should be 3x faster than full ${full.ms}ms`);
  console.log(`    [timing] full=${full.ms}ms slim-fields=${slim.ms}ms`);
});

test("store: requesting lastSeenAt keeps the scan (no silent wrong data)", t => {
  const { store, ownerKey } = serveBusy(t);
  const body = store.presence(ownerKey, "commons", [], { fields: ["memberId", "lastSeenAt"] });
  const full = store.presence(ownerKey, "commons", []);
  const byId = new Map(full.members.map(m => [m.memberId, m.lastSeenAt]));
  for (const m of body.members) {
    assert.deepEqual(Object.keys(m).sort(), ["lastSeenAt", "memberId"]);
    assert.equal(m.lastSeenAt, byId.get(m.memberId));
  }
});

test("store: invalid fields rejected at the store level too", t => {
  const { store, ownerKey } = serveBusy(t);
  assert.throws(
    () => store.presence(ownerKey, "commons", [], { fields: ["memberId", "nope"] }),
    err => err.code === "invalid_presence_fields");
});

test("store: 10 sequential readers — fast modes never slower than the slow path", t => {
  const { store, ownerKey } = serveBusy(t);
  store.presence(ownerKey, "commons", []); // warm
  const fullRuns = [];
  for (let i = 0; i < 10; i++) fullRuns.push(timeIt(() => store.presence(ownerKey, "commons", [])).ms);
  const countRuns = [];
  for (let i = 0; i < 10; i++) countRuns.push(timeIt(() => store.presence(ownerKey, "commons", [], { countOnly: true })).ms);
  const sum = a => a.reduce((x, y) => x + y, 0);
  const fullTotal = sum(fullRuns), countTotal = sum(countRuns);
  // The concurrent-reader case (LOAD c16: ~3x under 10 parallel readers) must
  // not regress: 10 fast-mode reads stay well under 10 slow reads.
  assert.ok(countTotal < fullTotal,
    `10x countOnly ${countTotal}ms should stay under 10x full ${fullTotal}ms`);
  console.log(`    [timing] 10x full=${fullTotal}ms 10x countOnly=${countTotal}ms`);
});
