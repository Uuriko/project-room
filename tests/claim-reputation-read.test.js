// Read side of the claim-bonds P1 reputation projector: the visible
// scoreboard (leaderboard + my-standing) and its HTTP routes.
//
// What these protect (test-audit authoring gate):
// 1. Contract: the read side folds the SAME work_claim.updated event rows
//    the journal sync reads (readClaimEventRows shares the parse/skip
//    rules), through the SAME projectClaimReputation fold, so the visible
//    scoreboard can never disagree with the journaled signals. The
//    leaderboard orders by decayed score (not raw), and the caller's own
//    standing is the claimReputationSummary shape the module already
//    documents for routing visibility.
// 2. Credible regressions: leaderboard sorted by raw instead of decayed
//    score; a lane with open claims but no signals dropped from the board;
//    the hoarding-cap flag (atCap) off by one; limit=0/101/1.5 accepted or
//    limit ignored; an unknown lane throwing instead of returning zeros;
//    non-GET on the new routes returning 200 instead of 405; "me" returning
//    someone else's row; non-members reading the board.
// 3. No existing coverage: the read helpers and routes are new —
//    laneClaimBondVisibility/projectClaimReputation were write-side only.
// 4. No production seams: read helpers run against in-memory node:sqlite;
//    route tests use the fake-helpers pattern from lease-renewal.test.js
//    (throwing reject, capturing json) with a minimal store stub.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  HOARDING_CAP,
  laneClaimStanding,
  readClaimEventRows,
  roomClaimLeaderboard,
} from "../server/claim-reputation.mjs";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";

const T0 = Date.parse("2026-10-04T00:00:00.000Z");
const DAY = 24 * 3600 * 1000;

function eventDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE events (room_id TEXT, sequence INTEGER, id TEXT, body TEXT)");
  return db;
}

function insertEvent(db, roomId, seq, type, data, atMs) {
  const body = JSON.stringify({ type, at: new Date(atMs).toISOString(), data });
  db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, seq, `evt-${seq}`, body);
}

function claimEvent(db, roomId, seq, claimId, action, data = {}, atMs = T0 + seq * 60_000) {
  insertEvent(db, roomId, seq, "work_claim.updated",
    { workClaim: claimId, action, claimState: "claimed", ownerId: "lane-a", ...data }, atMs);
}

// Two completed claims for lane-a (+6), one completed (+3) and one flaked
// (-6) for lane-b, one open claim for lane-c (no signals yet).
function mixedDb() {
  const db = eventDb();
  claimEvent(db, "muse-room", 1, "c1", "claimed", { ownerId: "lane-a" });
  claimEvent(db, "muse-room", 2, "c1", "state_changed", { claimState: "done", ownerId: "lane-a" });
  claimEvent(db, "muse-room", 3, "c2", "claimed", { ownerId: "lane-a" });
  claimEvent(db, "muse-room", 4, "c2", "state_changed", { claimState: "done", ownerId: "lane-a" });
  claimEvent(db, "muse-room", 5, "c3", "claimed", { ownerId: "lane-b" });
  claimEvent(db, "muse-room", 6, "c3", "state_changed", { claimState: "done", ownerId: "lane-b" });
  claimEvent(db, "muse-room", 7, "c4", "claimed", { ownerId: "lane-b" });
  claimEvent(db, "muse-room", 8, "c4", "lease_expired", { ownerId: null, previousOwnerId: "lane-b" });
  claimEvent(db, "muse-room", 9, "c5", "claimed", { ownerId: "lane-c" });
  return db;
}

// --- readClaimEventRows ----------------------------------------------------

test("readClaimEventRows returns the room's parsed rows in sequence order", () => {
  const db = mixedDb();
  const rows = readClaimEventRows(db, "muse-room");
  assert.equal(rows.length, 9);
  assert.deepEqual(rows.map(r => r.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(rows.every(r => r.roomId === "muse-room" && Number.isFinite(r.atMs) && typeof r.data === "object"));
});

test("readClaimEventRows scopes by room and skips other event types and malformed rows", () => {
  const db = eventDb();
  claimEvent(db, "muse-room", 1, "c1", "claimed");
  claimEvent(db, "other-room", 2, "c9", "claimed");
  insertEvent(db, "muse-room", 3, "message.posted", { body: "hello" }, T0);
  db.prepare("INSERT INTO events VALUES(?,?,?,?)").run("muse-room", 4, "evt-4", "not json{{");
  db.prepare("INSERT INTO events VALUES(?,?,?,?)").run("muse-room", 5, "evt-5",
    JSON.stringify({ type: "work_claim.updated", at: "bogus", data: {} }));
  db.prepare("INSERT INTO events VALUES(?,?,?,?)").run("muse-room", 6, "evt-6",
    JSON.stringify({ type: "work_claim.updated", at: new Date(T0).toISOString() }));
  const rows = readClaimEventRows(db, "muse-room");
  assert.deepEqual(rows.map(r => r.seq), [1]);
});

// --- roomClaimLeaderboard ---------------------------------------------------

test("roomClaimLeaderboard ranks lanes by score, includes open-only lanes, and freezes output", () => {
  const board = roomClaimLeaderboard(mixedDb(), "muse-room", { nowMs: T0 + 9 * 60_000 });
  assert.equal(board.roomId, "muse-room");
  assert.deepEqual(board.lanes.map(l => l.agentId), ["lane-a", "lane-c", "lane-b"]);
  // Scores are decayed to nowMs (30-day half-life), so assert approximately.
  assert.ok(Math.abs(board.lanes[0].score - 6) < 0.01, `lane-a ~6, got ${board.lanes[0].score}`);
  assert.equal(board.lanes[0].band, "standard");
  assert.equal(board.lanes[0].positive, 2);
  // lane-c holds an open claim with no signals: score 0 outranks lane-b at -3.
  assert.equal(board.lanes[1].agentId, "lane-c");
  assert.equal(board.lanes[1].score, 0);
  assert.equal(board.lanes[1].openClaims, 1);
  assert.ok(Math.abs(board.lanes[2].score - (-3)) < 0.01, `lane-b ~-3, got ${board.lanes[2].score}`);
  assert.equal(board.lanes[2].negative, 1);
  assert.ok(Object.isFrozen(board) && Object.isFrozen(board.lanes)
    && board.lanes.every(Object.isFrozen));
});

test("roomClaimLeaderboard orders by decayed score, not raw score", () => {
  const db = eventDb();
  // lane-old banks +6 at T0; lane-new banks +3 fifty-nine days later.
  claimEvent(db, "muse-room", 1, "c1", "claimed", { ownerId: "lane-old" }, T0);
  claimEvent(db, "muse-room", 2, "c1", "state_changed", { claimState: "done", ownerId: "lane-old" }, T0 + 60_000);
  claimEvent(db, "muse-room", 3, "c2", "claimed", { ownerId: "lane-old" }, T0 + 120_000);
  claimEvent(db, "muse-room", 4, "c2", "state_changed", { claimState: "done", ownerId: "lane-old" }, T0 + 180_000);
  const late = T0 + 59 * DAY;
  claimEvent(db, "muse-room", 5, "c3", "claimed", { ownerId: "lane-new" }, late);
  claimEvent(db, "muse-room", 6, "c3", "state_changed", { claimState: "done", ownerId: "lane-new" }, late + 60_000);
  const board = roomClaimLeaderboard(db, "muse-room", { nowMs: T0 + 60 * DAY });
  // Raw: 6 > 3. Decayed (30-day half-life): ~1.5 < ~2.9.
  assert.equal(board.lanes[0].agentId, "lane-new");
  assert.equal(board.lanes[1].agentId, "lane-old");
  assert.ok(board.lanes[0].score > board.lanes[1].score);
});

test("roomClaimLeaderboard honors limit and rejects out-of-range limits", () => {
  const db = mixedDb();
  assert.equal(roomClaimLeaderboard(db, "muse-room", { limit: 2 }).lanes.length, 2);
  assert.equal(roomClaimLeaderboard(db, "muse-room").lanes.length, 3); // default 25 > 3 lanes
  for (const bad of [0, 101, 1.5, Number.NaN, "3"]) {
    assert.throws(() => roomClaimLeaderboard(db, "muse-room", { limit: bad }), /limit/);
  }
});

test("roomClaimLeaderboard is empty for a room with no claim events", () => {
  const board = roomClaimLeaderboard(eventDb(), "empty-room");
  assert.deepEqual(board.lanes, []);
  assert.equal(board.roomId, "empty-room");
});

// --- laneClaimStanding ------------------------------------------------------

test("laneClaimStanding returns the lane's full summary", () => {
  const s = laneClaimStanding(mixedDb(), "muse-room", "lane-a", { nowMs: T0 + 9 * 60_000 });
  assert.equal(s.agentId, "lane-a");
  assert.ok(Math.abs(s.score - 6) < 0.01, `lane-a ~6, got ${s.score}`);
  assert.equal(s.band, "standard");
  assert.equal(s.positive, 2);
  assert.equal(s.negative, 0);
  assert.equal(s.openClaims, 0);
  assert.equal(s.atCap, false);
});

test("laneClaimStanding flags atCap at the hoarding cap and zeros unknown lanes", () => {
  const db = eventDb();
  for (let i = 1; i <= HOARDING_CAP; i++) claimEvent(db, "muse-room", i, `c${i}`, "claimed", { ownerId: "busy" });
  const busy = laneClaimStanding(db, "muse-room", "busy");
  assert.equal(busy.openClaims, HOARDING_CAP);
  assert.equal(busy.atCap, true);
  const ghost = laneClaimStanding(db, "muse-room", "nobody");
  assert.equal(ghost.score, 0);
  assert.equal(ghost.band, "standard");
  assert.equal(ghost.openClaims, 0);
  assert.equal(ghost.atCap, false);
});

test("laneClaimStanding requires a non-empty agent id", () => {
  assert.throws(() => laneClaimStanding(eventDb(), "muse-room", ""), /agentId/);
  assert.throws(() => laneClaimStanding(eventDb(), "muse-room", null), /agentId/);
});

// --- HTTP routes ------------------------------------------------------------

const fakeHelpers = () => {
  const calls = [];
  const reject = (status, code, message) => {
    const error = new Error(message); error.status = status; error.code = code; throw error;
  };
  const json = (res, status, value) => { calls.push({ status, value }); return { status, value }; };
  return { calls, json, reject, body: async req => req.body };
};

const runRoute = async ({ route, memberId = "lane-a", method = "GET", search = "", db }) => {
  const helpers = fakeHelpers();
  // The GET-only reputation routes skip autonomy-tier enforcement; the POST
  // 405 probes use a db-less store (like lease-renewal.test.js) so the tier
  // lookup — a production-db concern — cannot fire before the 405.
  const store = {
    ...(db ? { db } : {}),
    roomAuthority: () => ({ ownerId: "owner", members: {
      "lane-a": { id: "lane-a", kind: "agent", active: true, permissions: ["accept_work"] },
      "lane-b": { id: "lane-b", kind: "agent", active: true, permissions: ["accept_work"] },
      "lane-c": { id: "lane-c", kind: "agent", active: true, permissions: ["accept_work"] },
    } }),
  };
  try {
    const out = await handleWorkClaims({ req: { method }, res: {},
      url: { searchParams: new URLSearchParams(search) }, store, roomId: "muse-room",
      auth: { member: { id: memberId, kind: "agent", permissions: ["accept_work"] } },
      workClaimRoute: route, workClaimId: null, helpers, registry: createWorkClaimRegistry() });
    return { out, error: null };
  } catch (error) {
    return { out: null, error };
  }
};

test("GET reputation returns the room leaderboard", async () => {
  const { out, error } = await runRoute({ route: "reputation", db: mixedDb() });
  assert.equal(error, null);
  assert.equal(out.status, 200);
  assert.deepEqual(out.value.lanes.map(l => l.agentId), ["lane-a", "lane-c", "lane-b"]);
  assert.equal(out.value.roomId, "muse-room");
});

test("GET reputation honors the limit query param and 422s a bad one", async () => {
  const { out, error } = await runRoute({ route: "reputation", db: mixedDb(), search: "limit=1" });
  assert.equal(error, null);
  assert.equal(out.value.lanes.length, 1);
  const bad = await runRoute({ route: "reputation", db: mixedDb(), search: "limit=500" });
  assert.equal(bad.error?.status, 422);
});

test("GET reputation/me returns the caller's own standing", async () => {
  const { out, error } = await runRoute({ route: "reputation-me", memberId: "lane-b", db: mixedDb() });
  assert.equal(error, null);
  assert.equal(out.status, 200);
  assert.equal(out.value.agentId, "lane-b");
  // The route decays to real now (days after the fixture), so assert approx.
  assert.ok(Math.abs(out.value.score - (-3)) < 0.5, `lane-b ~-3, got ${out.value.score}`);
  assert.equal(out.value.negative, 1);
});

test("reputation routes reject non-members and non-GET methods", async () => {
  const outsider = await runRoute({ route: "reputation", memberId: "stranger", db: mixedDb() });
  assert.equal(outsider.error?.status, 403);
  const meOutsider = await runRoute({ route: "reputation-me", memberId: "stranger", db: mixedDb() });
  assert.equal(meOutsider.error?.status, 403);
  const post = await runRoute({ route: "reputation", method: "POST", db: null });
  assert.equal(post.error?.status, 405);
  const mePost = await runRoute({ route: "reputation-me", method: "POST", db: null });
  assert.equal(mePost.error?.status, 405);
});
