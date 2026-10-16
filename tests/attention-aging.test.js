// Charter B-3 step 2: one aging doctrine over the ask families.
// Pins: the doctrine table matches the mechanisms' own constants, the
// classification states, the counted expired-undecided derivation, and
// the expiry sweep (scheduled, guarded, idempotent) that replaces the
// silent lazy lapse of access requests (E65).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { accessRequestSchema, REQUEST_TTL_MS } from "../server/access-requests.mjs";
import {
  ASK_AGING, DAY_MS, classifyAsk, summarizeAskAging,
  countExpiredUndecided, escalatedAccessRequests, expireAccessRequests,
} from "../server/attention-aging.mjs";
import { JOBS, jobByName } from "../server/jobs.mjs";

const NOW = Date.parse("2026-10-15T12:00:00Z");

test("doctrine constants match the mechanisms that already had clocks", () => {
  // Access requests: the doctrine IS the constant now (re-exported).
  assert.equal(ASK_AGING.access_request.ttlMs, REQUEST_TTL_MS);
  assert.equal(REQUEST_TTL_MS, 7 * DAY_MS);
  // The values the map recorded for the other clocked families.
  assert.equal(ASK_AGING.bond_proposal.ttlMs, 7 * DAY_MS);
  assert.equal(ASK_AGING.bounty_challenge.ttlMs, 3 * DAY_MS);
  assert.equal(ASK_AGING.bounty_challenge_small.ttlMs, 1 * DAY_MS);
  assert.equal(ASK_AGING.bounty_dispute.ttlMs, 14 * DAY_MS);
  assert.equal(ASK_AGING.bounty_dispute.expiry, "default-release");
  assert.equal(ASK_AGING.bounty_challenge.expiry, "auto-approve");
  assert.equal(ASK_AGING.access_request.expiry, "expire");
});

test("never-expiring families escalate instead of lapsing", () => {
  for (const name of ["reply_request", "dm_consent", "verification", "owner_decision", "inbox_draft"]) {
    assert.equal(ASK_AGING[name].ttlMs, null, name);
    assert.equal(ASK_AGING[name].expiry, "none", name);
    const old = classifyAsk({ family: name, createdAt: NOW - 365 * DAY_MS, now: NOW });
    assert.equal(old.state, "escalated", `${name} a year old is escalated, never expired`);
    assert.equal(old.expiresAt, null, name);
  }
});

test("classifyAsk: open -> escalated -> expired_undecided for a TTL family", () => {
  const createdAt = NOW;
  assert.equal(classifyAsk({ family: "access_request", createdAt, now: createdAt + 1 * DAY_MS }).state, "open");
  assert.equal(classifyAsk({ family: "access_request", createdAt, now: createdAt + 3 * DAY_MS }).state, "escalated");
  const lapsed = classifyAsk({ family: "access_request", createdAt, now: createdAt + 7 * DAY_MS + 1 });
  assert.equal(lapsed.state, "expired_undecided");
  assert.equal(lapsed.msToExpiry, 0);
  assert.match(lapsed.consequence, /lapses undecided/);
  // A decided ask is decided at any age.
  assert.equal(classifyAsk({ family: "access_request", createdAt, now: createdAt + 30 * DAY_MS, decided: true }).state, "decided");
  assert.throws(() => classifyAsk({ family: "nope", createdAt, now: NOW }), /unknown ask family/);
});

test("summarizeAskAging counts expired undecided as one derived number", () => {
  const items = [
    { family: "access_request", createdAt: NOW - 8 * DAY_MS },
    { family: "access_request", createdAt: NOW - 8 * DAY_MS },
    { family: "access_request", createdAt: NOW - 4 * DAY_MS },
    { family: "verification", createdAt: NOW - 30 * DAY_MS },
    { family: "reply_request", createdAt: NOW - 1 * DAY_MS },
  ];
  const summary = summarizeAskAging(items, NOW);
  assert.equal(summary.total, 5);
  assert.equal(summary.expiredUndecided, 2);
  assert.equal(summary.escalated, 2); // 4-day access ask + 30-day verification
  assert.equal(summary.open, 1);
  assert.equal(summary.byFamily.access_request.expiredUndecided, 2);
  assert.equal(summary.byFamily.verification.escalated, 1);
});

function setupStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-aging-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => NOW });
  store.initialize(initialRoom("commons"));
  store.db.exec(accessRequestSchema);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function seedRequest(store, { id, roomId = "commons", status = "pending", createdAt }) {
  store.db.prepare(`INSERT INTO access_requests
    (request_id, room_id, identity_id, display_name, requested_permissions, status, created_at)
    VALUES (?,?,?,?,?,?,?)`).run(id, roomId, `id-${id}`, `Name ${id}`, "[]", status, createdAt);
}

test("expiry sweep flips only past-TTL pending rows, across rooms, and is idempotent", t => {
  const store = setupStore(t);
  seedRequest(store, { id: "old-join", createdAt: NOW - 8 * DAY_MS });
  seedRequest(store, { id: "old-upgrade", status: "pending_upgrade", createdAt: NOW - 9 * DAY_MS });
  seedRequest(store, { id: "fresh", createdAt: NOW - 1 * DAY_MS });
  seedRequest(store, { id: "decided", status: "denied", createdAt: NOW - 30 * DAY_MS });
  seedRequest(store, { id: "other-room", roomId: "annex", createdAt: NOW - 8 * DAY_MS });

  const first = expireAccessRequests(store, { now: NOW });
  assert.equal(first.expired, 3);
  assert.deepEqual(first.byRoom, { commons: 2, annex: 1 });
  const states = Object.fromEntries(store.db.prepare("SELECT request_id, status FROM access_requests").all()
    .map(row => [row.request_id, row.status]));
  assert.equal(states["old-join"], "expired");
  assert.equal(states["old-upgrade"], "expired");
  assert.equal(states.fresh, "pending");
  assert.equal(states.decided, "denied");

  // The counted state the surfaces report.
  assert.equal(countExpiredUndecided(store.db), 3);
  assert.equal(countExpiredUndecided(store.db, { roomId: "commons" }), 2);
  assert.equal(countExpiredUndecided(store.db, { roomId: "commons", sinceMs: NOW - 8 * DAY_MS - 1, untilMs: NOW }), 1);

  // Idempotent: a scheduler retry (or both runtimes ticking) expires nothing twice.
  const second = expireAccessRequests(store, { now: NOW });
  assert.equal(second.expired, 0);
  assert.equal(countExpiredUndecided(store.db), 3);
});

test("escalatedAccessRequests lists pending asks past escalation age, before TTL", t => {
  const store = setupStore(t);
  seedRequest(store, { id: "young", createdAt: NOW - 1 * DAY_MS });
  seedRequest(store, { id: "aging", createdAt: NOW - 4 * DAY_MS });
  seedRequest(store, { id: "lapsed", createdAt: NOW - 9 * DAY_MS });
  const escalated = escalatedAccessRequests(store.db, { now: NOW });
  assert.deepEqual(escalated.map(row => row.requestId), ["aging"]);
  assert.equal(escalated[0].ageMs, 4 * DAY_MS);
});

test("the attention-aging job is registered for both runtimes and reports the count", async t => {
  const job = jobByName("attention-aging");
  assert.ok(job, "job registered");
  assert.deepEqual([...job.runtimes].sort(), ["node", "worker"]);
  assert.equal(job.cadenceMs, 60 * 60 * 1000);
  assert.ok(JOBS.includes(job));

  const store = setupStore(t);
  seedRequest(store, { id: "stale", createdAt: NOW - 8 * DAY_MS });
  const result = await job.run(store, { now: () => NOW, env: {} });
  assert.equal(result.expired, 1);
  assert.equal(result.expiredUndecidedTotal, 1);
  const again = await job.run(store, { now: () => NOW, env: {} });
  assert.equal(again.expired, 0);
});
