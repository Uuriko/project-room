import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readDoorFunnel, computeDoorFunnel, clampDoorFunnelWeeks, DOOR_FUNNEL_MAX_WEEKS, DOOR_FUNNEL_CACHE_MS } from "../server/door-funnel.mjs";
import { DOOR_FUNNEL_ROUTES, DOOR_FUNNEL_PUBLIC_CACHE, handleDoorFunnel } from "../server/routes/door-funnel.mjs";

// Wednesday 2026-10-21 11:00 America/Los_Angeles. Los Angeles Mondays in
// scope: Oct 5 / Oct 12 / Oct 19, each starting 07:00Z (PDT).
const NOW = Date.parse("2026-10-21T18:00:00.000Z");
const STARTS = ["2026-10-05T07:00:00.000Z", "2026-10-12T07:00:00.000Z", "2026-10-19T07:00:00.000Z"];

let seq = 0;
function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE events (room_id TEXT NOT NULL, sequence INTEGER NOT NULL, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, PRIMARY KEY(room_id, sequence));
           CREATE TABLE agent_identities (identity_id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);`);
  return db;
}
function join(db, roomId, at, type = "member.added", memberId = "mbr_secret_1") {
  seq += 1;
  db.prepare("INSERT INTO events (room_id, sequence, id, body) VALUES (?, ?, ?, ?)")
    .run(roomId, seq, `evt_${seq}`, JSON.stringify({ type, roomId, actorId: "owner_secret", at, data: { memberId, displayName: "Secret Joiner", kind: "agent", identityId: "ai_secretidentity" } }));
}
function event(db, roomId, at, type) {
  seq += 1;
  db.prepare("INSERT INTO events (room_id, sequence, id, body) VALUES (?, ?, ?, ?)")
    .run(roomId, seq, `evt_${seq}`, JSON.stringify({ type, roomId, actorId: "owner_secret", at, data: {} }));
}
function mint(db, createdAt, id = `ai_mint_${createdAt}`) {
  db.prepare("INSERT INTO agent_identities (identity_id, secret_hash, display_name, created_at) VALUES (?, ?, ?, ?)")
    .run(id, `hash_${id}`, "Minty Secret", createdAt);
}
const directoryOf = rooms => ({ list: () => ({ rooms, nextCursor: null }) });
const storeOf = (db, rooms) => ({ db, roomDirectory: directoryOf(rooms) });
const LISTED = [{ roomId: "room-a", memberCount: 30 }, { roomId: "room-b", memberCount: 87 }];

function seededDb() {
  const db = makeDb();
  join(db, "room-a", "2026-10-19T07:00:00.000Z"); // boundary: current week
  join(db, "room-a", "2026-10-20T15:00:00.000Z", "member.joined_via_invitation");
  join(db, "room-a", "2026-10-19T06:59:59.000Z"); // Sunday 23:59:59 PDT: previous week
  join(db, "room-a", "2026-10-06T12:00:00.000Z");
  event(db, "room-a", "2026-10-20T16:00:00.000Z", "message.posted"); // not a join
  join(db, "room-b", "2026-10-13T12:00:00.000Z");
  join(db, "room-secret", "2026-10-20T15:00:00.000Z"); // unlisted room
  mint(db, Date.parse("2026-10-20T00:00:00.000Z"));
  mint(db, Date.parse("2026-10-21T00:00:00.000Z"));
  mint(db, Date.parse("2026-10-12T07:00:00.000Z")); // boundary: previous week
  mint(db, Date.parse("2026-09-01T00:00:00.000Z")); // outside a 3-week window
  return db;
}

test("weekly joins aggregate per listed room from the join events", () => {
  const out = readDoorFunnel(storeOf(seededDb(), LISTED), { weeks: 3, now: NOW });
  assert.deepEqual(out.weeks.map(w => w.startsAt), STARTS);
  assert.deepEqual(out.weeks.map(w => w.joins), [
    { "room-a": 1, "room-b": 0 },
    { "room-a": 1, "room-b": 1 },
    { "room-a": 2, "room-b": 0 },
  ]);
});

test("mints are counted from agent_identities.created_at in the same weeks", () => {
  const out = readDoorFunnel(storeOf(seededDb(), LISTED), { weeks: 3, now: NOW, includeMints: true });
  assert.deepEqual(out.weeks.map(w => w.mints), [0, 1, 2]);
});

test("the public read omits identity mint counts", () => {
  const out = readDoorFunnel(storeOf(seededDb(), LISTED), { weeks: 3, now: NOW });
  for (const week of out.weeks) assert.equal(Object.hasOwn(week, "mints"), false);
  assert.ok(!JSON.stringify(out).includes("mints"));
});

test("a computed funnel is reused for ten minutes per weeks value", () => {
  const db = seededDb();
  const store = storeOf(db, LISTED);
  const first = readDoorFunnel(store, { weeks: 3, now: NOW, includeMints: true });
  join(db, "room-a", "2026-10-20T16:30:00.000Z");
  const second = readDoorFunnel(store, { weeks: 3, now: NOW + 60_000, includeMints: true });
  assert.deepEqual(second.weeks.map(week => week.joins), first.weeks.map(week => week.joins));
  assert.equal(second.generatedAt, first.generatedAt);
  const otherWindow = readDoorFunnel(store, { weeks: 2, now: NOW + 60_000, includeMints: true });
  assert.equal(otherWindow.generatedAt, new Date(NOW + 60_000).toISOString());
  assert.equal(otherWindow.weeks.at(-1).joins["room-a"], first.weeks[2].joins["room-a"] + 1);
  const later = readDoorFunnel(store, { weeks: 3, now: NOW + DOOR_FUNNEL_CACHE_MS, includeMints: true });
  assert.equal(later.weeks[2].joins["room-a"], first.weeks[2].joins["room-a"] + 1);
  assert.notEqual(later.generatedAt, first.generatedAt);
});

test("weeks parameter clamps to 1..12 with 12 as the default", () => {
  assert.equal(clampDoorFunnelWeeks(99), DOOR_FUNNEL_MAX_WEEKS);
  assert.equal(clampDoorFunnelWeeks(0), 1);
  assert.equal(clampDoorFunnelWeeks("abc"), 12);
  assert.equal(clampDoorFunnelWeeks(undefined), 12);
  const db = makeDb();
  assert.equal(readDoorFunnel(storeOf(db, []), { weeks: 99, now: NOW }).weeks.length, 12);
  assert.equal(readDoorFunnel(storeOf(db, []), { now: NOW }).weeks.length, 12);
});

test("empty store renders the full shape with zeros, never absence", () => {
  const out = readDoorFunnel(storeOf(makeDb(), LISTED), { weeks: 2, now: NOW });
  assert.equal(out.schema, "project-room-door-funnel/1");
  assert.equal(out.generatedAt, "2026-10-21T18:00:00.000Z");
  assert.deepEqual(out.weeks.map(w => w.joins), [{ "room-a": 0, "room-b": 0 }, { "room-a": 0, "room-b": 0 }]);
  assert.equal(out.weeks.some(week => Object.hasOwn(week, "mints")), false);
  const withMints = readDoorFunnel(storeOf(makeDb(), LISTED), { weeks: 2, now: NOW, includeMints: true });
  assert.deepEqual(withMints.weeks.map(w => w.mints), [0, 0]);
  assert.deepEqual(out.directory, { listedRooms: 2, totalMembers: 117, rooms: LISTED });
});

test("a listed room with no joins renders 0 and an unlisted room never appears", () => {
  const out = readDoorFunnel(storeOf(seededDb(), LISTED), { weeks: 3, now: NOW });
  for (const week of out.weeks) {
    assert.ok(Object.hasOwn(week.joins, "room-b"));
    assert.ok(!Object.hasOwn(week.joins, "room-secret"));
  }
  assert.equal(out.weeks[2].joins["room-b"], 0);
  assert.ok(!JSON.stringify(out).includes("room-secret"));
});

test("existence-hiding: no member, identity, or joiner data anywhere in the output", () => {
  const out = readDoorFunnel(storeOf(seededDb(), LISTED), { weeks: 3, now: NOW });
  const text = JSON.stringify(out);
  for (const secret of ["mbr_secret_1", "Secret Joiner", "ai_secretidentity", "ai_mint_", "Minty Secret", "owner_secret", "secret_hash"]) {
    assert.ok(!text.includes(secret), `leaked ${secret}`);
  }
  assert.deepEqual(Object.keys(out).sort(), ["classifier", "directory", "generatedAt", "schema", "weeks"]);
  for (const week of out.weeks) assert.deepEqual(Object.keys(week).sort(), ["joins", "startsAt"]);
  const owner = readDoorFunnel(storeOf(seededDb(), LISTED), { weeks: 3, now: NOW, includeMints: true });
  const ownerText = JSON.stringify(owner);
  for (const secret of ["mbr_secret_1", "Secret Joiner", "ai_secretidentity", "ai_mint_", "Minty Secret", "owner_secret", "secret_hash"]) {
    assert.ok(!ownerText.includes(secret), `owner read leaked ${secret}`);
  }
});

test("anonymous-readable shape: the read takes no credential and claims no fleet/outside split", () => {
  // The route serves this read with no auth argument at all; the module's
  // only inputs are the store, the week count, and the clock.
  const out = readDoorFunnel(storeOf(seededDb(), LISTED), { weeks: 3, now: NOW });
  assert.equal(out.classifier.available, false);
  assert.match(out.classifier.reason, /No fleet marker/);
  const text = JSON.stringify(out.weeks);
  assert.ok(!text.includes("fleet"));
  assert.ok(!text.includes("outside"));
});

test("a missing source refuses the whole read instead of silently zeroing a leg", () => {
  const bare = new DatabaseSync(":memory:"); // no events / agent_identities tables
  assert.throws(
    () => computeDoorFunnel(bare, { listedRooms: LISTED, weeks: 3, now: NOW }),
    error => error.code === "door_funnel_unavailable" && error.status === 500,
  );
  assert.throws(
    () => readDoorFunnel({ db: makeDb() }, { now: NOW }),
    error => error.code === "door_funnel_unavailable",
  );
});

// ---- route handler (server/routes/door-funnel.mjs) -------------------------
// The handler is exercised directly with the fake-ctx shape the route tests
// use (account-sessions-route): rate records its call, json returns the
// { status, body } pair it was handed. The store is the same in-memory
// fixture store the read tests above drive.
function routeCtx(store, search = "") {
  const calls = [];
  return {
    calls,
    res: { headers: {}, setHeader(name, value) { this.headers[name.toLowerCase()] = value; } },
    store,
    remoteAddress: "203.0.113.9",
    url: new URL(`https://example.test/api/public/door-funnel${search}`),
    rate: (key, max) => calls.push(["rate", key, max]),
    json: (_res, status, body) => ({ status, body }),
  };
}

test("the route row is the anonymous counts-only GET the table carries", () => {
  assert.equal(DOOR_FUNNEL_ROUTES.length, 1);
  const [row] = DOOR_FUNNEL_ROUTES;
  assert.equal(row.id, "public.door-funnel");
  assert.equal(row.method, "GET");
  assert.equal(row.path, "/api/public/door-funnel");
  assert.equal(row.auth, "none");
  assert.equal(row.handler, handleDoorFunnel);
});

test("the handler rate-limits by remote address, then serves the funnel read", () => {
  const ctx = routeCtx(storeOf(seededDb(), LISTED));
  const out = handleDoorFunnel(ctx);
  assert.deepEqual(ctx.calls, [["rate", "door-funnel:203.0.113.9", 120]]);
  assert.equal(out.status, 200);
  assert.equal(out.body.schema, "project-room-door-funnel/1");
  assert.equal(out.body.weeks.length, DOOR_FUNNEL_MAX_WEEKS);
  assert.equal(out.body.weeks.some(week => Object.hasOwn(week, "mints")), false);
  assert.equal(ctx.res.headers["cache-control"], DOOR_FUNNEL_PUBLIC_CACHE);
  assert.deepEqual(out.body.directory, { listedRooms: 2, totalMembers: 117, rooms: LISTED });
});

test("a room owner receives mint counts on a private response; another member does not", () => {
  // The handler reads the funnel at the real clock (no now injection), so
  // this test seeds mints relative to today: two in the current week, one
  // in the previous week, none the week before — the [0, 1, 2] shape the
  // fixed-date seed produced only while the calendar sat in its week.
  const db = makeDb();
  const nowMs = Date.now();
  mint(db, nowMs - 60_000);
  mint(db, nowMs - 120_000);
  mint(db, nowMs - 7 * 24 * 3600_000);
  const store = storeOf(db, LISTED);
  store.roomAuthority = () => ({ ownerId: "owner-1" });
  store.authenticate = token => {
    if (token === "owner-token") return { roomId: "room-a", member: { id: "owner-1" } };
    if (token === "member-token") return { roomId: "room-a", member: { id: "member-2" } };
    const error = new Error("unknown");
    error.status = 401;
    throw error;
  };
  const ownerCtx = routeCtx(store, "?weeks=3");
  ownerCtx.req = { headers: { authorization: "Bearer owner-token" } };
  ownerCtx.bearer = () => "owner-token";
  const owner = handleDoorFunnel(ownerCtx);
  assert.deepEqual(owner.body.weeks.map(week => week.mints), [0, 1, 2]);
  assert.equal(ownerCtx.res.headers["cache-control"], "private, no-store");
  assert.equal(ownerCtx.res.headers.vary, "Authorization, Cookie");

  const memberCtx = routeCtx(store, "?weeks=3");
  memberCtx.req = { headers: { authorization: "Bearer member-token" } };
  memberCtx.bearer = () => "member-token";
  const member = handleDoorFunnel(memberCtx);
  assert.equal(member.body.weeks.some(week => Object.hasOwn(week, "mints")), false);
  assert.equal(memberCtx.res.headers["cache-control"], DOOR_FUNNEL_PUBLIC_CACHE);

  const rejectedCtx = routeCtx(store, "?weeks=3");
  rejectedCtx.req = { headers: { authorization: "Bearer nope" } };
  rejectedCtx.bearer = () => "nope";
  const rejected = handleDoorFunnel(rejectedCtx);
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.weeks.some(week => Object.hasOwn(week, "mints")), false);

  const cookieDb = makeDb();
  mint(cookieDb, nowMs - 60_000);
  mint(cookieDb, nowMs - 120_000);
  mint(cookieDb, nowMs - 7 * 24 * 3600_000);
  const cookieStore = storeOf(cookieDb, LISTED);
  cookieStore.authenticate = () => { const error = new Error("no token"); error.status = 401; throw error; };
  cookieStore.roomAuthority = () => ({ ownerId: "owner-1" });
  cookieStore.authenticateAccountSession = () => ({ account: { id: "acct-1" } });
  const prepare = cookieStore.db.prepare.bind(cookieStore.db);
  cookieStore.db.prepare = sql => String(sql).includes("member_accounts")
    ? { all: () => [{ roomId: "room-a", memberId: "owner-1" }] }
    : prepare(sql);
  const cookieCtx = routeCtx(cookieStore, "?weeks=3");
  cookieCtx.req = { headers: { cookie: "account_session=slot-1" } };
  cookieCtx.cookie = () => "slot-1";
  cookieCtx.accountCookieName = "account_session";
  const cookieOwner = handleDoorFunnel(cookieCtx);
  assert.deepEqual(cookieOwner.body.weeks.map(week => week.mints), [0, 1, 2]);
  assert.equal(cookieCtx.res.headers["cache-control"], "private, no-store");
});

test("the handler passes the weeks query parameter through the clamp", () => {
  const store = storeOf(makeDb(), LISTED);
  assert.equal(handleDoorFunnel(routeCtx(store, "?weeks=2")).body.weeks.length, 2);
  assert.equal(handleDoorFunnel(routeCtx(store, "?weeks=99")).body.weeks.length, DOOR_FUNNEL_MAX_WEEKS);
  assert.equal(handleDoorFunnel(routeCtx(store, "?weeks=abc")).body.weeks.length, DOOR_FUNNEL_MAX_WEEKS);
});

test("the handler propagates a source refusal instead of serving a partial read", () => {
  const ctx = routeCtx({ db: makeDb() }); // no roomDirectory attached
  assert.throws(
    () => handleDoorFunnel(ctx),
    error => error.code === "door_funnel_unavailable" && error.status === 500,
  );
  assert.deepEqual(ctx.calls, [["rate", "door-funnel:203.0.113.9", 120]]);
});
