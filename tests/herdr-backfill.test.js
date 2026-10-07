// herdr backfill executor (lane B21) — fail-first tests.
// scripts/herdr-backfill.mjs attaches herdr sessions to existing opted-in
// in-flight claims. Contract under test:
//   - idempotent + resumable; progress journaled in herdr_session_journal
//   - --dry-run writes nothing; --confirm executes
//   - eligibility: claim in_progress + lane opted in + ROOM_HERDR_SESSIONS covers room
//   - claim state / owner / claimedAt NEVER change (history-append only)
// Fail-first: these tests are written before the script exists.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createBackfillExecutor, ensureHerdrTables } from "../scripts/herdr-backfill.mjs";

const T0 = Date.parse("2026-10-06T21:30:00.000Z");
const H = 3600 * 1000;

// --- fakes ---------------------------------------------------------------

function makeClaim(id, { state = "in_progress", owner = "jill", leaseH = 24 } = {}) {
  return {
    id,
    title: `work ${id}`,
    state,
    owner,
    claimedAt: new Date(T0).toISOString(),
    leaseStartAt: new Date(T0).toISOString(),
    leaseExpiresAt: new Date(T0 + leaseH * H).toISOString(),
    history: [],
  };
}

function harness({ claims = {}, optedIn = [], flagRooms = ["muse-room"], bridgeOk = true, protocolVersion = 22 } = {}) {
  const db = new DatabaseSync(":memory:");
  ensureHerdrTables(db);
  const store = new Map(Object.entries(claims)); // claimId -> item (single room)
  const historyBefore = new Map();
  const bridge = {
    pingCalls: 0,
    spawnCalls: [],
    failSpawnFor: new Set(),
    alivePanes: new Set(),
    ping() {
      this.pingCalls++;
      if (!bridgeOk) throw new Error("bridge unreachable");
      return { ok: true, protocolVersion };
    },
    spawnAgent({ agentKind, resumeSessionRef, metadata }) {
      if (this.failSpawnFor.has(metadata.claim_id)) throw new Error("spawn exploded");
      const sessionId = `sess_${metadata.claim_id}`;
      this.spawnCalls.push({ agentKind, resumeSessionRef, metadata });
      this.alivePanes.add(sessionId);
      return { sessionId };
    },
    paneAlive(sessionId) { return this.alivePanes.has(sessionId); },
  };
  const ex = createBackfillExecutor({
    db,
    now: () => T0,
    listClaims: () => [...store.values()],
    getClaim: (roomId, claimId) => store.get(claimId) ?? null,
    recordHistory: (roomId, claimId, entry) => {
      const item = store.get(claimId);
      assert.ok(item, "recordHistory on missing claim");
      item.history = [...item.history, { at: new Date(T0).toISOString(), ...entry }];
      return item;
    },
    isOptedIn: (roomId, memberId) => optedIn.includes(`${roomId}:${memberId}`),
    flagCoversRoom: roomId => flagRooms.includes(roomId),
    agentKindFor: () => "claude-code",
    bridge,
    pinnedProtocolVersion: 22,
  });
  return { db, store, bridge, ex, historyBefore };
}

const journalRows = (db, kind) =>
  db.prepare(`SELECT * FROM herdr_session_journal ${kind ? "WHERE kind = ?" : ""} ORDER BY seq`)
    .all(...(kind ? [kind] : []));
const sessions = db => db.prepare("SELECT * FROM herdr_sessions ORDER BY session_id").all();

// --- dry-run --------------------------------------------------------------

test("backfill: dry-run is the default and writes nothing anywhere", () => {
  const { db, store, bridge, ex } = harness({
    claims: { c1: makeClaim("c1") },
    optedIn: ["muse-room:jill"],
  });
  const before = JSON.stringify(store.get("c1"));
  const res = ex.enumerate(["muse-room"]);
  assert.equal(res.length, 1);
  assert.equal(res[0].eligible, true);
  assert.equal(journalRows(db).length, 0);
  assert.equal(sessions(db).length, 0);
  assert.equal(bridge.spawnCalls.length, 0);
  assert.equal(JSON.stringify(store.get("c1")), before);
});

test("backfill: eligibility — only in_progress + opted-in + flag-covered claims pass", () => {
  const { ex } = harness({
    claims: {
      ok: makeClaim("ok"),
      claimed: makeClaim("claimed", { state: "claimed" }),
      blocked: makeClaim("blocked", { state: "blocked" }),
      done: makeClaim("done", { state: "done" }),
      lapsed: makeClaim("lapsed", { leaseH: -1 }),
      stranger: makeClaim("stranger", { owner: "fo" }),
    },
    optedIn: ["muse-room:jill"], // fo never opted in
  });
  const byId = Object.fromEntries(ex.enumerate(["muse-room"]).map(r => [r.claimId, r]));
  assert.equal(byId.ok.eligible, true);
  assert.equal(byId.claimed.eligible, false);
  assert.equal(byId.claimed.reason, "not_in_progress");
  assert.equal(byId.blocked.eligible, false);
  assert.equal(byId.blocked.reason, "not_in_progress");
  assert.equal(byId.done.eligible, false);
  assert.equal(byId.done.reason, "claim_terminal");
  assert.equal(byId.lapsed.eligible, false);
  assert.equal(byId.lapsed.reason, "lease_expired");
  assert.equal(byId.stranger.eligible, false);
  assert.equal(byId.stranger.reason, "not_opted_in");
});

test("backfill: room outside the flag scope is skipped", () => {
  const { ex } = harness({
    claims: { c1: makeClaim("c1") },
    optedIn: ["other-room:jill"],
    flagRooms: ["other-room"],
  });
  const [r] = ex.enumerate(["muse-room"]);
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "room_not_in_flag_scope");
});

// --- execute --------------------------------------------------------------

test("backfill: --confirm attaches the session, journals the chain, and never touches claim state", () => {
  const { db, store, bridge, ex } = harness({
    claims: { c1: makeClaim("c1"), c2: makeClaim("c2") },
    optedIn: ["muse-room:jill"],
  });
  const before1 = { ...store.get("c1"), history: undefined };
  const res = ex.execute(["muse-room"], { confirm: true });
  assert.equal(res.exitCode, 0);
  assert.deepEqual(res.outcomes, ["migrated", "migrated"]);
  assert.equal(bridge.spawnCalls.length, 2);
  for (const call of bridge.spawnCalls) {
    assert.equal(call.agentKind, "claude-code");
    assert.equal(call.metadata.backfill, "true");
    assert.ok(call.metadata.claim_id && call.metadata.member_id && call.metadata.room_id);
  }
  // claim invariant: state / owner / claimedAt byte-identical; history grew
  const after1 = store.get("c1");
  assert.equal(after1.state, before1.state);
  assert.equal(after1.owner, before1.owner);
  assert.equal(after1.claimedAt, before1.claimedAt);
  assert.equal(after1.history.length, 1);
  assert.equal(after1.history[0].kind, "session_migrated");
  assert.equal(after1.history[0].from, "legacy");
  assert.equal(after1.history[0].to, "herdr");
  // session linkage
  assert.equal(sessions(db).length, 2);
  assert.ok(sessions(db).every(s => s.backend === "herdr" && s.status === "open"));
  // journal chain: start -> done per claim, idempotency keyed
  assert.equal(journalRows(db, "backfill_start").length, 2);
  assert.equal(journalRows(db, "backfill_done").length, 2);
  for (const row of journalRows(db)) {
    assert.ok(row.idempotency_key.startsWith("backfill:muse-room:c"));
  }
});

test("backfill: second run is a no-op — completed claims are skipped, never double-spawned", () => {
  const { db, bridge, ex } = harness({
    claims: { c1: makeClaim("c1") },
    optedIn: ["muse-room:jill"],
  });
  ex.execute(["muse-room"], { confirm: true });
  assert.equal(bridge.spawnCalls.length, 1);
  const res = ex.execute(["muse-room"], { confirm: true });
  assert.deepEqual(res.outcomes, ["skipped"]);
  assert.equal(res.skips[0].reason, "already_migrated");
  assert.equal(bridge.spawnCalls.length, 1); // no second pane for the same claim
  assert.equal(journalRows(db, "backfill_start").length, 1);
});

test("backfill: re-run after partial completion resumes — no claim processed twice", () => {
  const { db, bridge, ex } = harness({
    claims: { c1: makeClaim("c1"), c2: makeClaim("c2"), c3: makeClaim("c3") },
    optedIn: ["muse-room:jill"],
  });
  bridge.failSpawnFor.add("c2"); // crash mid-batch on the second claim
  const first = ex.execute(["muse-room"], { confirm: true, batch: 5 });
  assert.equal(first.exitCode, 1);
  assert.deepEqual(first.outcomes, ["migrated", "aborted"]);
  assert.equal(journalRows(db, "backfill_done").length, 1);
  assert.equal(journalRows(db, "backfill_aborted").length, 1);
  bridge.failSpawnFor.delete("c2"); // operator fixes the cause
  const second = ex.execute(["muse-room"], { confirm: true, resume: true });
  assert.equal(second.exitCode, 0);
  assert.deepEqual(second.outcomes, ["skipped", "migrated", "migrated"]);
  assert.equal(second.skips[0].reason, "already_migrated"); // c1 not re-spawned
  assert.equal(bridge.spawnCalls.length, 3); // c1, c2, c3 — exactly once each
});

test("backfill: bridge unreachable fails closed before any claim is touched", () => {
  const { db, bridge, ex } = harness({
    claims: { c1: makeClaim("c1") },
    optedIn: ["muse-room:jill"],
    bridgeOk: false,
  });
  const res = ex.execute(["muse-room"], { confirm: true });
  assert.equal(res.exitCode, 2); // systemic halt
  assert.equal(bridge.spawnCalls.length, 0);
  assert.equal(journalRows(db, "backfill_start").length, 0);
  assert.equal(journalRows(db, "backfill_done").length, 0);
  assert.deepEqual(res.outcomes, ["halted"]);
});

test("backfill: bridge protocol version mismatch fails closed with a clear skip reason", () => {
  const { db, bridge, ex } = harness({
    claims: { c1: makeClaim("c1") },
    optedIn: ["muse-room:jill"],
    protocolVersion: 21, // pinned is 22
  });
  const res = ex.execute(["muse-room"], { confirm: true });
  assert.equal(res.exitCode, 2);
  assert.equal(bridge.spawnCalls.length, 0);
  assert.equal(journalRows(db, "backfill_done").length, 0);
});

test("backfill: batch boundary halts the wave on systemic failure", () => {
  const { bridge, ex } = harness({
    claims: { c1: makeClaim("c1"), c2: makeClaim("c2") },
    optedIn: ["muse-room:jill"],
    bridgeOk: false,
  });
  const res = ex.execute(["muse-room"], { confirm: true, batch: 1 });
  assert.equal(res.exitCode, 2);
  assert.equal(res.halted, true);
  assert.equal(bridge.spawnCalls.length, 0);
});

test("backfill: cursor is journaled so --resume starts where the last run stopped", () => {
  const { db, ex } = harness({
    claims: { c1: makeClaim("c1"), c2: makeClaim("c2") },
    optedIn: ["muse-room:jill"],
  });
  ex.execute(["muse-room"], { confirm: true, limit: 1 });
  const cur = db.prepare("SELECT * FROM herdr_backend_state WHERE key = 'backfill_cursor'").get();
  assert.ok(cur);
  assert.equal(JSON.parse(cur.value).lastClaimId, "c1");
  const second = ex.execute(["muse-room"], { confirm: true, resume: true });
  assert.deepEqual(second.outcomes, ["skipped", "migrated"]);
});

test("backfill: already-herdr claim (open session row) is skipped, never re-spawned", () => {
  const { db, bridge, ex } = harness({
    claims: { c1: makeClaim("c1") },
    optedIn: ["muse-room:jill"],
  });
  db.prepare(`INSERT INTO herdr_sessions
    (session_id, room_id, member_id, claim_id, backend, attached_at, status)
    VALUES ('sess_old', 'muse-room', 'jill', 'c1', 'herdr', ?, 'open')`)
    .run(new Date(T0).toISOString());
  const res = ex.execute(["muse-room"], { confirm: true });
  assert.deepEqual(res.outcomes, ["skipped"]);
  assert.equal(res.skips[0].reason, "already_migrated");
  assert.equal(bridge.spawnCalls.length, 0);
});
