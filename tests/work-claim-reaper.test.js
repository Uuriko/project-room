// Server-side claim reaper (guild-claimsboard B2, system #4).
//
// Contract guarded here (owner boundary — nothing else covers the tick):
//  - expired work -> deterministic succession (hint > hash > open pool),
//    10-min exclusive adopt window, failed adoption -> open pool
//  - expired land -> unclaimed + lease cleared
//  - expired deploy -> escalated, state held, lease cleared, max ONE
//    coalesced room event per tick
//  - grace (work 15m / land 5m / deploy 0) + 2x grace forgiveness
//  - null-lease legacy reaped iff untouched for 24h
//  - leader lock: two reapers -> single actor; 90s silence expiry
//  - correlated-death detector: >=15 silent or >=30% (>=3) silent in ~120s
//    -> 30-min HOLD, park orphans, release nothing
//  - <=5 dispositions per cycle; quiet tick -> zero writes
//  - ZERO room events for routine dispositions; epoch+1 on every reap
//
// Authoring-gate answers: (1) the tick/lock/disposition orchestration is the
// behavior; (2) credible regressions are double-grant, mass-reap into a fire,
// grace/forgiveness violations, event-budget burn, lost epoch bumps; (3) the
// pure state machine (work-claim-leases, work-claim-epoch-fencing) and the
// per-request sweep (work-claim-sweep) do not cover the tick; (4) the only
// seam is the tick's option bag, which production also uses.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../server/work-claim-sqlite.mjs";
import { createWork, claimWork, updateWork } from "../server/work-claims.mjs";
import {
  reapTick, acquireReaperLock, releaseReaperLock, reaperDueAt,
  REAPER_TICK_MS, REAPER_MAX_DISPOSITIONS,
} from "../server/work-claim-reaper.mjs";
import { jobByName } from "../server/jobs.mjs";

const T0 = Date.parse("2026-10-07T22:00:00.000Z");
const MIN = 60_000;
const HOUR = 3600_000;
let nowMs = T0;

const agentMember = id => ({ id, kind: "agent", active: true, permissions: ["accept_work", "complete_work"] });

function makeStore(t, { members = {}, heartbeats = [], ownerId = "owner1" } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "reaper-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(join(dir, "room.sqlite"));
  db.exec(workClaimSchema);
  db.exec(`CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, projection TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS events (room_id TEXT NOT NULL, sequence INTEGER NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS identity_links (room_id TEXT NOT NULL, member_id TEXT NOT NULL, identity_id TEXT NOT NULL, PRIMARY KEY (room_id, member_id))`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_hosts (agent_id TEXT NOT NULL, host_id TEXT NOT NULL, mode TEXT NOT NULL, last_seen_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (agent_id, host_id))`);
  db.prepare("INSERT INTO rooms VALUES (?,?,?)").run("room1", 0, JSON.stringify({
    room: { id: "room1", ownerId }, members, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {},
  }));
  const link = db.prepare("INSERT INTO identity_links VALUES (?,?,?)");
  const beat = db.prepare("INSERT INTO agent_hosts VALUES (?,?,?,?,?,?)");
  for (const { member, agent, seenAgoMs } of heartbeats) {
    link.run("room1", member, agent);
    beat.run(agent, "host1", "wakeable", nowMs - seenAgoMs, nowMs - seenAgoMs, nowMs - seenAgoMs);
  }
  const registry = createDurableWorkClaimRegistry(db, { now: () => nowMs });
  return {
    db,
    workClaims: registry,
    now: () => nowMs,
    roomAuthority: () => ({ ownerId, members }),
    room: roomId => {
      const row = db.prepare("SELECT sequence, projection FROM rooms WHERE id=?").get(roomId);
      return row ? { sequence: row.sequence, state: JSON.parse(row.projection) } : null;
    },
  };
}

// A claim whose lease lapsed `agoMs` before nowMs.
function lapsedClaim(registry, id, owner, { kind = "work", agoMs = 20 * MIN, leaseHours = 1, hint = null } = {}) {
  const claimedAt = nowMs - agoMs - leaseHours * HOUR;
  let item = claimWork({ id, kind }, owner, { leaseHours, now: claimedAt });
  if (hint) item = { ...item, successorHint: hint };
  registry.set("room1", item);
  return registry.get("room1", id);
}

const live3 = () => ({
  m1: agentMember("m1"), m2: agentMember("m2"), m3: agentMember("m3"),
});
const beatsFresh = () => [
  { member: "m1", agent: "a1", seenAgoMs: 10_000 },
  { member: "m2", agent: "a2", seenAgoMs: 10_000 },
  { member: "m3", agent: "a3", seenAgoMs: 10_000 },
];

const hashPick = (claimId, live) => {
  const sorted = [...live].sort();
  const digest = createHash("sha256").update(claimId).digest();
  return sorted[Number(digest.readBigUInt64BE() % BigInt(sorted.length))];
};

test("job registry: claim-reaper ticks every 30s on worker and node", () => {
  const job = jobByName("claim-reaper");
  assert.ok(job, "claim-reaper is registered");
  assert.equal(job.cadenceMs, REAPER_TICK_MS);
  assert.equal(REAPER_TICK_MS, 30_000);
  assert.deepEqual([...job.runtimes].sort(), ["node", "worker"]);
});

test("reaper: expired work claim successed to hash-elected live successor, zero room events", async t => {
  nowMs = T0;
  const store = makeStore(t, {
    members: live3(),
    heartbeats: [
      { member: "m1", agent: "a1", seenAgoMs: 600_000 }, // lapsed owner silent
      { member: "m2", agent: "a2", seenAgoMs: 10_000 },
      { member: "m3", agent: "a3", seenAgoMs: 10_000 },
    ],
  });
  const before = lapsedClaim(store.workClaims, "c1", "m1", { agoMs: 20 * MIN });
  const out = reapTick(store, { now: () => nowMs, holderId: "r1" });
  assert.equal(out.ok, true);
  assert.equal(out.succeeded.length, 1);
  const after = store.workClaims.get("room1", "c1");
  const expected = hashPick("c1", ["m2", "m3"]); // lapsed owner excluded
  assert.equal(after.owner, expected);
  assert.equal(after.state, "claimed");
  assert.equal(after.epoch, (before.epoch ?? 0) + 1);
  assert.ok(after.history.at(-1).action.startsWith("succession:"));
  // 10-min exclusive adopt window lease
  assert.equal(Date.parse(after.leaseExpiresAt) - nowMs, 10 * MIN);
  // ZERO room events for routine dispositions
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
});

test("reaper: live successor_hint beats the hash", async t => {
  nowMs = T0;
  const store = makeStore(t, {
    members: live3(),
    heartbeats: [
      { member: "m1", agent: "a1", seenAgoMs: 600_000 },
      { member: "m2", agent: "a2", seenAgoMs: 10_000 },
      { member: "m3", agent: "a3", seenAgoMs: 10_000 },
    ],
  });
  lapsedClaim(store.workClaims, "c1", "m1", { agoMs: 20 * MIN, hint: "m3" });
  reapTick(store, { now: () => nowMs, holderId: "r1" });
  assert.equal(store.workClaims.get("room1", "c1").owner, "m3");
});

test("reaper: dead hint falls through to the hash", async t => {
  nowMs = T0;
  const store = makeStore(t, {
    members: live3(),
    heartbeats: [
      { member: "m1", agent: "a1", seenAgoMs: 600_000 }, // lapsed owner silent
      { member: "m2", agent: "a2", seenAgoMs: 10_000 },
      { member: "m3", agent: "a3", seenAgoMs: 600_000 }, // hinted member stale
    ],
  });
  lapsedClaim(store.workClaims, "c1", "m1", { agoMs: 20 * MIN, hint: "m3" });
  reapTick(store, { now: () => nowMs, holderId: "r1" });
  // m3 is not live; m1 excluded as lapsed owner -> only m2 remains
  assert.equal(store.workClaims.get("room1", "c1").owner, "m2");
});

test("reaper: no live successors -> open pool (unclaimed)", async t => {
  nowMs = T0;
  const store = makeStore(t, {
    members: live3(),
    // only the lapsed owner ever heartbeated, and went silent: nobody live.
    // (single silent member < the hold detector's >=3 minimum, so no HOLD.)
    heartbeats: [{ member: "m1", agent: "a1", seenAgoMs: 600_000 }],
  });
  const before = lapsedClaim(store.workClaims, "c1", "m1", { agoMs: 20 * MIN });
  const out = reapTick(store, { now: () => nowMs, holderId: "r1" });
  assert.equal(out.released.length, 1);
  const after = store.workClaims.get("room1", "c1");
  assert.equal(after.state, "unclaimed");
  assert.equal(after.owner, null);
  assert.equal(after.epoch, (before.epoch ?? 0) + 1);
});

test("reaper: hash successor that never adopts -> open pool on the next lapse", async t => {
  nowMs = T0;
  const store = makeStore(t, {
    members: live3(),
    heartbeats: [
      { member: "m1", agent: "a1", seenAgoMs: 600_000 },
      { member: "m2", agent: "a2", seenAgoMs: 10_000 },
      { member: "m3", agent: "a3", seenAgoMs: 10_000 },
    ],
  });
  lapsedClaim(store.workClaims, "c1", "m1", { agoMs: 20 * MIN });
  reapTick(store, { now: () => nowMs, holderId: "r1" });
  const successor = store.workClaims.get("room1", "c1").owner;
  assert.notEqual(successor, "m1");
  // successor never acts; the 10-min adopt lease lapses, then grace passes.
  // refresh the survivors' heartbeats so the death detector stays quiet.
  // (successor is alive -> forgiveness stretches the horizon to 2x grace.)
  nowMs = T0 + 10 * MIN + 31 * MIN;
  store.db.prepare("UPDATE agent_hosts SET last_seen_at=? WHERE agent_id IN ('a2','a3')").run(nowMs);
  const out = reapTick(store, { now: () => nowMs, holderId: "r1" });
  assert.equal(out.released.length, 1);
  const after = store.workClaims.get("room1", "c1");
  assert.equal(after.state, "unclaimed");
  assert.match(after.history.at(-1).note, /adopt/i);
});

test("reaper: expired land -> unclaimed, lease cleared, epoch bumped", async t => {
  nowMs = T0;
  const store = makeStore(t, {
    members: live3(),
    heartbeats: [{ member: "m1", agent: "a1", seenAgoMs: 600_000 }],
  });
  const before = lapsedClaim(store.workClaims, "l1", "m1", { kind: "land", agoMs: 10 * MIN });
  reapTick(store, { now: () => nowMs, holderId: "r1" });
  const after = store.workClaims.get("room1", "l1");
  assert.equal(after.state, "unclaimed");
  assert.equal(after.owner, null);
  assert.equal(after.leaseExpiresAt, null);
  assert.equal(after.epoch, (before.epoch ?? 0) + 1);
  assert.equal(after.history.at(-1).action, "lease_expired");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
});

test("reaper: expired deploy -> escalated, state held, one coalesced event per tick", async t => {
  nowMs = T0;
  const members = { owner: agentMember("owner"), ...live3() };
  const store = makeStore(t, { members, heartbeats: beatsFresh(), ownerId: "owner" });
  const mk = id => {
    const claimedAt = nowMs - 2 * HOUR;
    const item = claimWork({ id, kind: "deploy", revision: "r1" }, "m1", { leaseHours: 1, now: claimedAt });
    store.workClaims.set("room1", item);
  };
  mk("d1"); mk("d2");
  const out = reapTick(store, { now: () => nowMs, holderId: "r1" });
  assert.equal(out.escalated.length, 2);
  for (const id of ["d1", "d2"]) {
    const after = store.workClaims.get("room1", id);
    assert.equal(after.state, "claimed", "deploy state is held, never auto-reaped");
    assert.equal(after.owner, "m1");
    assert.equal(after.leaseExpiresAt, null, "lease cleared so it is not re-escalated");
    assert.equal(after.history.at(-1).action, "escalated");
  }
  // max ONE coalesced room event per tick, not per lease
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);
});

test("reaper: already-escalated deploy is not re-escalated", async t => {
  nowMs = T0;
  const store = makeStore(t, { members: live3(), heartbeats: beatsFresh() });
  const claimedAt = nowMs - 2 * HOUR;
  store.workClaims.set("room1", claimWork({ id: "d1", kind: "deploy", revision: "r1" }, "m1", { leaseHours: 1, now: claimedAt }));
  reapTick(store, { now: () => nowMs, holderId: "r1" });
  nowMs = T0 + 25 * HOUR; // past the null-lease legacy window
  const out = reapTick(store, { now: () => nowMs, holderId: "r1" });
  assert.equal(out.escalated.length, 0);
  assert.equal(store.workClaims.get("room1", "d1").history.filter(h => h.action === "escalated").length, 1);
});

test("reaper: null-lease legacy reaped iff untouched for 24h", async t => {
  const store = makeStore(t, { members: live3(), heartbeats: beatsFresh() });
  nowMs = T0 - 25 * HOUR;
  const old = claimWork({ id: "old1" }, "m1", { leaseHours: null, now: nowMs });
  store.workClaims.set("room1", old);
  nowMs = T0 - 23 * HOUR;
  const young = claimWork({ id: "young1" }, "m1", { leaseHours: null, now: nowMs });
  store.workClaims.set("room1", young);
  nowMs = T0;
  const out = reapTick(store, { now: () => nowMs, holderId: "r1" });
  assert.ok(out.released.includes("old1") || out.succeeded.includes("old1"), "25h-untouched legacy reaped");
  assert.equal(store.workClaims.get("room1", "young1").state, "claimed", "23h-untouched legacy skipped");
});

test("reaper: grace — work expired 5m ago is not reaped, 35m ago is", async t => {
  nowMs = T0;
  const store = makeStore(t, { members: live3(), heartbeats: beatsFresh() });
  lapsedClaim(store.workClaims, "fresh", "m1", { agoMs: 5 * MIN });
  lapsedClaim(store.workClaims, "stale", "m1", { agoMs: 35 * MIN }); // past 2x grace even for a live owner
  const out = reapTick(store, { now: () => nowMs, holderId: "r1" });
  assert.equal(store.workClaims.get("room1", "fresh").owner, "m1", "inside grace+forgiveness: untouched");
  assert.ok(out.succeeded.includes("stale") || out.released.includes("stale"));
});

test("reaper: forgiveness — owner alive within 2x grace is deferred, silent owner is reaped", async t => {
  nowMs = T0;
  const store = makeStore(t, { members: live3(), heartbeats: beatsFresh() });
  lapsedClaim(store.workClaims, "c1", "m1", { agoMs: 20 * MIN }); // past 15m grace, inside 30m forgiveness
  const out = reapTick(store, { now: () => nowMs, holderId: "r1" });
  assert.equal(out.deferred.length, 1, "live owner inside forgiveness window: deferred");
  assert.equal(store.workClaims.get("room1", "c1").owner, "m1");
  // owner goes silent -> reaped on the next tick
  store.db.prepare("UPDATE agent_hosts SET last_seen_at=? WHERE agent_id='a1'").run(nowMs - 600_000);
  const out2 = reapTick(store, { now: () => nowMs, holderId: "r1" });
  assert.equal(out2.deferred.length, 0);
  assert.ok(out2.succeeded.includes("c1") || out2.released.includes("c1"));
});

test("reaper: two reapers -> single actor; stale lock expires after 90s", async t => {
  nowMs = T0;
  const store = makeStore(t, { members: live3(), heartbeats: beatsFresh() });
  assert.equal(acquireReaperLock(store.db, "A", nowMs), true);
  assert.equal(acquireReaperLock(store.db, "B", nowMs), false, "B is fenced while A holds the lock");
  nowMs = T0 + 89_000;
  assert.equal(acquireReaperLock(store.db, "B", nowMs), false, "89s silence: still held");
  nowMs = T0 + 91_000;
  assert.equal(acquireReaperLock(store.db, "B", nowMs), true, "90s+ silence: B takes over");
  releaseReaperLock(store.db, "B");
  assert.equal(acquireReaperLock(store.db, "A", nowMs), true, "released lock is acquirable");
});

test("reaper: quiet tick -> zero writes", async t => {
  nowMs = T0;
  const store = makeStore(t, { members: live3(), heartbeats: beatsFresh() });
  const item = claimWork({ id: "c1" }, "m1", { leaseHours: 24, now: nowMs });
  store.workClaims.set("room1", item);
  const before = store.db.prepare("SELECT room_id, claim_id, item_json FROM work_claims").all();
  const out = reapTick(store, { now: () => nowMs, holderId: "r1" });
  assert.equal(out.ok, true);
  assert.deepEqual(out.succeeded, []);
  assert.deepEqual(out.released, []);
  assert.deepEqual(out.escalated, []);
  const after = store.db.prepare("SELECT room_id, claim_id, item_json FROM work_claims").all();
  assert.deepEqual(after, before, "no claim row touched");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
});

test("reaper: at most 5 dispositions per cycle", async t => {
  nowMs = T0;
  const store = makeStore(t, {
    members: live3(),
    heartbeats: [{ member: "m1", agent: "a1", seenAgoMs: 600_000 }],
  });
  for (let i = 0; i < 8; i++) lapsedClaim(store.workClaims, `l${i}`, "m1", { kind: "land", agoMs: 10 * MIN });
  const out = reapTick(store, { now: () => nowMs, holderId: "r1" });
  assert.equal(out.released.length, REAPER_MAX_DISPOSITIONS);
  assert.equal(REAPER_MAX_DISPOSITIONS, 5);
  const remaining = store.workClaims.list("room1").filter(i => i.state === "claimed").length;
  assert.equal(remaining, 3, "the rest wait for the next cycle");
});

test("reaper: correlated death -> 30-min HOLD, park orphans, release nothing", async t => {
  nowMs = T0;
  const members = {};
  const heartbeats = [];
  for (let i = 1; i <= 20; i++) {
    members[`m${i}`] = agentMember(`m${i}`);
    heartbeats.push({ member: `m${i}`, agent: `a${i}`, seenAgoMs: 130_000 }); // silent ~130s
  }
  const store = makeStore(t, { members, heartbeats });
  lapsedClaim(store.workClaims, "c1", "m1", { agoMs: 20 * MIN });
  const out = reapTick(store, { now: () => nowMs, holderId: "r1" });
  assert.ok(out.held.includes("room1"), "room is held");
  assert.deepEqual(out.succeeded, []);
  assert.deepEqual(out.released, []);
  assert.equal(store.workClaims.get("room1", "c1").owner, "m1", "orphan parked, not released");
  // hold expires after 30 min AND the agents recover -> reaping resumes
  nowMs = T0 + 31 * MIN;
  store.db.prepare("UPDATE agent_hosts SET last_seen_at=?").run(nowMs);
  const out2 = reapTick(store, { now: () => nowMs, holderId: "r1" });
  assert.ok(!out2.held.includes("room1"));
  assert.ok(out2.succeeded.includes("c1") || out2.released.includes("c1"), "reaping resumes after hold + recovery");
});

test("reaper: stale_epoch fences the resurrected holder after succession", async t => {
  nowMs = T0;
  const store = makeStore(t, {
    members: live3(),
    heartbeats: [
      { member: "m1", agent: "a1", seenAgoMs: 600_000 },
      { member: "m2", agent: "a2", seenAgoMs: 10_000 },
      { member: "m3", agent: "a3", seenAgoMs: 10_000 },
    ],
  });
  const before = lapsedClaim(store.workClaims, "c1", "m1", { agoMs: 20 * MIN });
  const oldEpoch = before.epoch ?? 0;
  reapTick(store, { now: () => nowMs, holderId: "r1" });
  const after = store.workClaims.get("room1", "c1");
  assert.throws(
    () => updateWork(after, "m1", { note: "i am back", expectedEpoch: oldEpoch, now: nowMs }),
    error => error.code === "stale_epoch",
    "resurrected holder presenting the pre-succession epoch is rejected"
  );
});

test("reaper: reaperDueAt reports the next lease+grace horizon", async t => {
  nowMs = T0;
  const store = makeStore(t, { members: live3(), heartbeats: beatsFresh() });
  assert.equal(reaperDueAt(store, nowMs), null, "empty board: nothing due");
  lapsedClaim(store.workClaims, "c1", "m1", { agoMs: 5 * MIN }); // work: 15m grace
  const due = reaperDueAt(store, nowMs);
  assert.ok(Number.isFinite(due), "a due time is reported");
  assert.ok(due > nowMs && due <= nowMs + 10 * MIN + 1000, `due ~10m out, got ${due - nowMs}ms`);
});
