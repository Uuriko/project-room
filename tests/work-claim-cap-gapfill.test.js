// WAVE-300 FIX-18: 200-open-claim cap gap-fill.
//
// Gaps over the deployed close/cancel path (main #1999) and the unmerged
// guild-claimsboard/lease-first-reaper branch:
//   (a) release-at-expiry semantics — auto-released orphans land in the
//       `expired` state: out of the open count, still re-claimable, never
//       dropped, cap never violated.
//   (b) refusal determinism + documented error.code branching — 409
//       work_board_full / too_many_open_claims / work_claim_conflict carry
//       the recovery hint on the wire and are byte-identical across retries
//       (modulo the per-request operationId).
//   (c) stale-claim auto-retirement semantics — opt-in per-room TTL;
//       unclaimed/expired items with no activity past the TTL are closed
//       (never deleted), disabled by default.
//
// Authoring gate:
// 1. Observable contracts: expiry lands outside the cap count but keeps the
//    item claimable; cap refusals are deterministic; stale retirement only
//    fires when the room opts in.
// 2. Credible regressions: a refactor that routes expiry back to `unclaimed`
//    re-bricks full boards; a hint regression strands clients on the generic
//    "unknown error" text; an unconditional retire sweep would close live
//    backlog.
// 3. Existing coverage: tests/work-claim-leases.test.js covers lease expiry
//    to `unclaimed` (the old semantic — updated by this change);
//    tests/concurrency-race.test.js covers the double-claim race.
// 4. No test-only seam: the pure state machine, the real HTTP routes, and
//    the real SQLite store are the surfaces under test.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWork, claimWork, closeWork, reassignWork, releaseExpired,
  retireStaleClaims, countsTowardBoardCap, roomWorkClaimConfig,
  isTerminalClaimState, ClaimError,
} from "../server/work-claims.mjs";
import { agentErrorAx } from "../src/agent-error.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof ClaimError && error.code === code);
const T0 = Date.parse("2026-10-08T12:00:00.000Z");
const H = 3600 * 1000;
const DAY = 24 * H;

// ---------------------------------------------------------------------------
// (a) release-at-expiry semantics
// ---------------------------------------------------------------------------

test("(a) releaseExpired: a lapsed lease lands in `expired`, not `unclaimed`", () => {
  const claimed = claimWork({ id: "w1", title: "orphan work" }, "quill", { leaseHours: 1, now: T0 });
  const [expired] = releaseExpired([claimed], T0 + 2 * H);
  assert.equal(expired.state, "expired");
  assert.equal(expired.owner, null);
  assert.equal(expired.leaseExpiresAt, null);
  // never dropped: identity, title and the lapse record survive
  assert.equal(expired.id, "w1");
  assert.equal(expired.title, "orphan work");
  const lapse = expired.history.filter(h => h.action === "lease_expired");
  assert.equal(lapse.length, 1);
  assert.match(lapse[0].note, /auto-released|quill/);
});

test("(a) releaseExpired: items without a lapsed lease pass through untouched", () => {
  const noLease = claimWork({ id: "w2" }, "quill", { leaseHours: null, now: T0 });
  const [same] = releaseExpired([noLease], T0 + 365 * DAY);
  assert.equal(same.state, "claimed");
  assert.equal(same.owner, "quill");
  const fresh = claimWork({ id: "w3" }, "quill", { leaseHours: 2, now: T0 });
  const [live] = releaseExpired([fresh], T0 + H);
  assert.equal(live.state, "claimed");
});

test("(a) countsTowardBoardCap: expired/done/closed are out, everything else is in", () => {
  for (const state of ["unclaimed", "claimed", "in_progress", "blocked"]) {
    assert.equal(countsTowardBoardCap({ state }), true, `${state} counts`);
  }
  for (const state of ["expired", "done", "closed"]) {
    assert.equal(countsTowardBoardCap({ state }), false, `${state} does not count`);
  }
  // expired is cap-excluded but NOT terminal: it stays re-claimable
  assert.equal(isTerminalClaimState("expired"), false);
  assert.equal(isTerminalClaimState("done"), true);
  assert.equal(isTerminalClaimState("closed"), true);
});

test("(a) an expired claim can be claimed again — the orphan is never dropped", () => {
  const claimed = claimWork({ id: "w4", title: "revivable" }, "quill", { leaseHours: 1, now: T0 });
  const [expired] = releaseExpired([claimed], T0 + 2 * H);
  const revived = claimWork(expired, "rhea", { leaseHours: 2, now: T0 + 2 * H });
  assert.equal(revived.state, "claimed");
  assert.equal(revived.owner, "rhea");
  assert.equal(revived.title, "revivable");
  assert.ok(revived.history.some(h => h.action === "lease_expired"), "lapse stays in history");
});

test("(a) close/cancel work from `expired`: authority closes, opener cancels", () => {
  const claimed = claimWork({ id: "w5" }, "quill", { leaseHours: 1, now: T0 });
  const [expired] = releaseExpired([claimed], T0 + 2 * H);
  const closed = closeWork(expired, "manager", { verb: "close", reason: "stale", now: T0 + 2 * H, authority: true });
  assert.equal(closed.state, "closed");
  assert.equal(closed.history.at(-1).action, "closed");

  const mine = createWork({ id: "w6" }, { now: T0, agentId: "rhea" });
  const held = claimWork(mine, "quill", { leaseHours: 1, now: T0 });
  const [expiredMine] = releaseExpired([held], T0 + 2 * H);
  const cancelled = closeWork(expiredMine, "rhea", { verb: "cancel", reason: "never mind", now: T0 + 2 * H });
  assert.equal(cancelled.state, "closed");
  assert.equal(cancelled.history.at(-1).action, "cancelled");
});

test("(a) reassign refuses an expired item — claim it first", () => {
  const claimed = claimWork({ id: "w7" }, "quill", { leaseHours: 1, now: T0 });
  const [expired] = releaseExpired([claimed], T0 + 2 * H);
  throwsCode(() => reassignWork(expired, "manager", "rhea", { authority: true, now: T0 + 2 * H }), "invalid_claim_input");
});

// ---------------------------------------------------------------------------
// (c) stale-claim auto-retirement semantics
// ---------------------------------------------------------------------------

test("(c) retireStaleClaims: stale unclaimed/expired items are closed, never deleted", () => {
  const ttl = 30 * DAY;
  const stale = createWork({ id: "s1", title: "abandoned" }, { now: T0, agentId: "quill" });
  const [retired] = retireStaleClaims([stale], { now: T0 + 31 * DAY, staleAfterMs: ttl });
  assert.equal(retired.state, "closed");
  assert.equal(retired.id, "s1");
  assert.equal(retired.title, "abandoned");
  const stamp = retired.history.at(-1);
  assert.equal(stamp.action, "stale_retired");
  assert.match(stamp.note ?? "", /auto-retired/);
});

test("(c) retireStaleClaims: recent activity, active states and terminal states are untouched", () => {
  const ttl = 30 * DAY;
  const fresh = createWork({ id: "s2" }, { now: T0 + 29 * DAY, agentId: "quill" });
  const [kept] = retireStaleClaims([fresh], { now: T0 + 31 * DAY, staleAfterMs: ttl });
  assert.equal(kept.state, "unclaimed");

  const active = claimWork({ id: "s3" }, "quill", { leaseHours: null, now: T0 });
  const [held] = retireStaleClaims([active], { now: T0 + 300 * DAY, staleAfterMs: ttl });
  assert.equal(held.state, "claimed");

  const done = { ...createWork({ id: "s4" }, { now: T0, agentId: "quill" }), state: "done" };
  const [doneKept] = retireStaleClaims([done], { now: T0 + 300 * DAY, staleAfterMs: ttl });
  assert.equal(doneKept.state, "done");
});

test("(c) retireStaleClaims: disabled by default (null TTL is a no-op) and never mutates input", () => {
  const stale = createWork({ id: "s5" }, { now: T0, agentId: "quill" });
  const before = JSON.parse(JSON.stringify(stale));
  const out = retireStaleClaims([stale], { now: T0 + 300 * DAY, staleAfterMs: null });
  assert.equal(out[0].state, "unclaimed");
  assert.deepEqual(JSON.parse(JSON.stringify(stale)), before);
});

test("(c) roomWorkClaimConfig: staleClaimTtlMs defaults to null and validates", () => {
  assert.equal(roomWorkClaimConfig({}).staleClaimTtlMs, null);
  assert.equal(roomWorkClaimConfig({ workClaims: {} }).staleClaimTtlMs, null);
  assert.equal(roomWorkClaimConfig({ workClaims: { staleClaimTtlMs: 7 * DAY } }).staleClaimTtlMs, 7 * DAY);
  for (const bad of [0, -5, 1000, 3.5, "7d", NaN]) {
    assert.equal(roomWorkClaimConfig({ workClaims: { staleClaimTtlMs: bad } }).staleClaimTtlMs, null,
      `invalid ttl ${String(bad)} falls back to null`);
  }
});

// ---------------------------------------------------------------------------
// (b) refusal error.code branching (agentErrorAx)
// ---------------------------------------------------------------------------

test("(b) agentErrorAx: cap/conflict codes carry the recovery hint, not the generic unknown-error text", () => {
  const full = agentErrorAx({ httpStatus: 409, code: "work_board_full", message: "x", roomId: "r1" });
  assert.equal(full.status, "action_required");
  assert.equal(full.reason, "work_board_full");
  assert.match(full.hint, /close/i);
  assert.ok(!/unknown error/i.test(full.hint));

  const member = agentErrorAx({ httpStatus: 409, code: "too_many_open_claims", message: "x", roomId: "r1" });
  assert.equal(member.status, "action_required");
  assert.equal(member.reason, "too_many_open_claims");
  assert.match(member.hint, /release or finish/i);

  const conflict = agentErrorAx({ httpStatus: 409, code: "work_claim_conflict", message: "x", roomId: "r1", workItemId: "w1" });
  assert.equal(conflict.status, "action_required");
  assert.equal(conflict.reason, "work_claim_conflict");
  assert.ok(!/unknown error/i.test(conflict.hint));
});

// ---------------------------------------------------------------------------
// HTTP: scratch-room runs (criteria 1 + 2)
// ---------------------------------------------------------------------------

const ROOM = "commons";
const scratchDir = () => {
  const dir = join(process.env.TMPDIR ?? join(dirname(fileURLToPath(import.meta.url)), ".tmp"),
    `cap-gapfill-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

async function fixture(t) {
  const dir = scratchDir();
  const store = new RoomStore(join(dir, "cap.sqlite"));
  store.initialize(initialRoom(ROOM));
  const ownerKey = store.issueAccessKey(ROOM, "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, token, body) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, value: await response.json().catch(() => ({})) };
  };
  // Enroll a contribute-profile member and hand back their access key.
  // Members are also how the 200-fill spreads its writes: the server allows
  // 60 writes/minute per credential.
  const enroll = async name => {
    const identity = store.identities.create(name);
    const memberId = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32);
    store.identities.link(ownerKey, ROOM, {
      identityId: identity.identityId, memberId, displayName: name,
      permissions: ["accept_work", "complete_work"],
    });
    return { memberId, key: store.issueAccessKey(ROOM, memberId) };
  };
  return { store, ownerKey, call, enroll };
}

// Seed `count` items straight into the room's SQLite registry (pure
// createWork/claimWork, no HTTP writes): the cap predicate under test is the
// same one the create route evaluates.
function seedBoard(store, roomId, count, { claim = false, agentId = "seeder", now = Date.now() } = {}) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const id = `seed-${agentId}-${i}`;
    let item = createWork({ id, title: `seed ${id}` }, { now, agentId });
    if (claim) item = claimWork(item, agentId, { leaseHours: 1, now });
    store.workClaims.set(roomId, item);
    ids.push(id);
  }
  return ids;
}

const stripVolatile = value => {
  const copy = JSON.parse(JSON.stringify(value));
  delete copy.operationId;
  return copy;
};

test("(crit 2) HTTP: at open=200, create is 409 work_board_full with the documented hint, byte-identical on retry",
  { timeout: 120000 }, async t => {
    const { store, call, ownerKey } = await fixture(t);
    seedBoard(store, ROOM, 200);
    assert.equal(store.workClaims.list(ROOM).filter(countsTowardBoardCap).length, 200);
    const first = await call("POST", `/api/rooms/${ROOM}/work-claims`, ownerKey,
      { id: "cap-overflow-1", title: "overflow one" });
    assert.equal(first.status, 409);
    assert.equal(first.value?.error?.code, "work_board_full");
    // the documented recovery hint rides on the wire body
    assert.match(String(first.value?.hint ?? ""), /close or \/cancel/i);
    const second = await call("POST", `/api/rooms/${ROOM}/work-claims`, ownerKey,
      { id: "cap-overflow-2", title: "overflow two" });
    assert.equal(second.status, 409);
    assert.equal(second.value?.error?.code, "work_board_full");
    // determinism: identical refusal envelope on retry (operationId is per-request)
    assert.deepEqual(stripVolatile(second.value), stripVolatile(first.value));
  });

test("(crit 1) HTTP scratch-room: fill 200, expire all, close all — board returns to accepting creates, nothing dropped",
  { timeout: 180000 }, async t => {
    const { store, call, ownerKey, enroll } = await fixture(t);
    // ten members × 20 claimed items: each member stays under the 20-claim
    // member cap and under the 60-writes/minute credential budget.
    const members = [];
    for (let m = 0; m < 10; m++) {
      const member = await enroll(`Fill Member ${m}`);
      members.push(member);
      seedBoard(store, ROOM, 20, { claim: true, agentId: member.memberId });
    }
    assert.equal(store.workClaims.list(ROOM).length, 200);
    // expire everything: lapsed leases leave the open count but keep the items
    const future = Date.now() + 2 * H;
    for (const item of store.workClaims.list(ROOM)) {
      const [expired] = releaseExpired([item], future);
      store.workClaims.set(ROOM, expired);
    }
    const afterExpiry = store.workClaims.list(ROOM);
    assert.equal(afterExpiry.length, 200, "nothing dropped by expiry");
    assert.ok(afterExpiry.every(item => item.state === "expired"));
    assert.equal(afterExpiry.filter(countsTowardBoardCap).length, 0, "open count is 0 after expiry");

    // the board accepts creates again without any close
    const revived = await call("POST", `/api/rooms/${ROOM}/work-claims`, ownerKey,
      { id: "fill-after-expiry", title: "after expiry" });
    assert.equal(revived.status, 201, `create after expiry failed: ${JSON.stringify(revived.value).slice(0, 200)}`);

    // the close path (cancel by the opener) still works on expired items
    for (const member of members) {
      for (let i = 0; i < 20; i++) {
        const id = `seed-${member.memberId}-${i}`;
        const cancelled = await call("POST", `/api/rooms/${ROOM}/work-claims/${id}/cancel`, member.key,
          { reason: "scratch cleanup" });
        assert.equal(cancelled.status, 200, `cancel ${id} failed: ${JSON.stringify(cancelled.value).slice(0, 200)}`);
        assert.equal(cancelled.value.state, "closed");
      }
    }
    const afterClose = await call("POST", `/api/rooms/${ROOM}/work-claims`, ownerKey,
      { id: "fill-after-close", title: "after close" });
    assert.equal(afterClose.status, 201);
    const board = store.workClaims.list(ROOM);
    assert.equal(board.length, 202, "every item still present: 200 closed + 2 created");
    assert.equal(board.filter(item => item.state === "closed").length, 200);
  });

test("(a) HTTP: an expired claim is re-claimable over the claim route", { timeout: 60000 }, async t => {
  const { store, call, ownerKey } = await fixture(t);
  const created = await call("POST", `/api/rooms/${ROOM}/work-claims`, ownerKey,
    { id: "revive-1", title: "revivable" });
  assert.equal(created.status, 201);
  const claimed = await call("POST", `/api/rooms/${ROOM}/work-claims/revive-1/claim`, ownerKey, { leaseHours: 1 });
  assert.equal(claimed.status, 200);
  const [expired] = releaseExpired([store.workClaims.get(ROOM, "revive-1")], Date.now() + 2 * H);
  store.workClaims.set(ROOM, expired);
  const reclaimed = await call("POST", `/api/rooms/${ROOM}/work-claims/revive-1/claim`, ownerKey, { note: "back" });
  assert.equal(reclaimed.status, 200, `re-claim failed: ${JSON.stringify(reclaimed.value).slice(0, 200)}`);
  assert.equal(reclaimed.value.state, "claimed");
  assert.equal(reclaimed.value.title, "revivable");
});
