// RC-2026-09-18-043: coordination norms as room config defaults.
// Pure module tests; no store, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { claimWork, updateWork } from "../server/work-claims.mjs";
import {
  DEFAULT_NORMS, NORM_KEYS, NORM_DESCRIPTIONS, NormsError,
  getRoomNorms, setRoomNorms, resetRoomNorms, coordinationNormsBlock,
  assertClaimAllowed, staleClaims, shouldStopWaking,
} from "../server/room-norms.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof NormsError && error.code === code);
const room = suffix => `norms-test-${suffix}`;

test("defaults are present on new rooms", () => {
  const norms = getRoomNorms(room("fresh"));
  assert.deepEqual(norms, { maxClaimsPerAgentPerCycle: 1, releaseOnInactivityHours: 24, stopAfterRepeatedNoopWakes: 5 });
  assert.deepEqual(norms, DEFAULT_NORMS);
  assert.deepEqual([...NORM_KEYS].sort(), ["maxClaimsPerAgentPerCycle", "releaseOnInactivityHours", "stopAfterRepeatedNoopWakes"].sort());
  assert.ok(Object.isFrozen(norms));
  for (const key of NORM_KEYS) assert.equal(typeof NORM_DESCRIPTIONS[key], "string");
  throwsCode(() => getRoomNorms(""), "norms_invalid_input");
});

test("owner can override per room; overrides merge over defaults", () => {
  const id = room("override");
  const merged = setRoomNorms(id, { maxClaimsPerAgentPerCycle: 3 }, { isOwner: true });
  assert.deepEqual(merged, { maxClaimsPerAgentPerCycle: 3, releaseOnInactivityHours: 24, stopAfterRepeatedNoopWakes: 5 });
  // Second patch merges onto the first; other rooms are untouched.
  setRoomNorms(id, { stopAfterRepeatedNoopWakes: 8 }, { isOwner: true });
  assert.equal(getRoomNorms(id).maxClaimsPerAgentPerCycle, 3);
  assert.equal(getRoomNorms(id).stopAfterRepeatedNoopWakes, 8);
  assert.deepEqual(getRoomNorms(room("untouched")), DEFAULT_NORMS);
  // Reset restores defaults.
  assert.deepEqual(resetRoomNorms(id, { isOwner: true }), DEFAULT_NORMS);
});

test("non-owners cannot change norms; patches are validated", () => {
  const id = room("guarded");
  throwsCode(() => setRoomNorms(id, { maxClaimsPerAgentPerCycle: 2 }, { isOwner: false }), "norms_not_owner");
  throwsCode(() => setRoomNorms(id, { maxClaimsPerAgentPerCycle: 2 }), "norms_not_owner");
  throwsCode(() => resetRoomNorms(id, { isOwner: false }), "norms_not_owner");
  throwsCode(() => setRoomNorms(id, { bogusNorm: 1 }, { isOwner: true }), "norms_invalid_patch");
  throwsCode(() => setRoomNorms(id, {}, { isOwner: true }), "norms_invalid_patch");
  throwsCode(() => setRoomNorms(id, null, { isOwner: true }), "norms_invalid_patch");
  throwsCode(() => setRoomNorms(id, { maxClaimsPerAgentPerCycle: 0 }, { isOwner: true }), "norms_invalid_patch");
  throwsCode(() => setRoomNorms(id, { maxClaimsPerAgentPerCycle: 11 }, { isOwner: true }), "norms_invalid_patch");
  throwsCode(() => setRoomNorms(id, { maxClaimsPerAgentPerCycle: 1.5 }, { isOwner: true }), "norms_invalid_patch");
  throwsCode(() => setRoomNorms(id, { releaseOnInactivityHours: 721 }, { isOwner: true }), "norms_invalid_patch");
  throwsCode(() => setRoomNorms(id, { stopAfterRepeatedNoopWakes: "many" }, { isOwner: true }), "norms_invalid_patch");
  assert.deepEqual(getRoomNorms(id), DEFAULT_NORMS);
});

test("one-claim-per-cycle is enforced in the claim path", () => {
  const items = [claimWork({ id: "w1" }, "quill"), claimWork({ id: "w2" }, "grok")];
  // quill holds one active claim; the default norm allows one.
  throwsCode(() => assertClaimAllowed(items, "quill"), "norm_claim_limit");
  // An agent holding nothing may claim; the guard returns the active count.
  assert.equal(assertClaimAllowed(items, "instinct"), 0);
  // Released claims free the slot.
  const released = items.map(item => item.owner === "quill" ? updateWork(item, "quill", { state: "unclaimed" }) : item);
  assert.equal(assertClaimAllowed(released, "quill"), 0);
  // Finished claims do not count either.
  const started = updateWork(items[1], "grok", { state: "in_progress" });
  const done = updateWork(started, "grok", { state: "done" });
  assert.equal(assertClaimAllowed([done], "grok"), 0);
  // A room override raises the enforced limit.
  assert.equal(assertClaimAllowed(items, "quill", { norms: { maxClaimsPerAgentPerCycle: 2 } }), 1);
  throwsCode(() => assertClaimAllowed(items, "not-an-agent".repeat(20)), "norms_invalid_input");
});

test("inactivity release hooks into lease expiry via last-activity stamps", () => {
  const hour = 60 * 60 * 1000;
  const t0 = Date.now();
  const iso = ms => new Date(ms).toISOString();
  // work-claims shape: last activity is the latest history stamp, and
  // claimWork always stamps "now" — so an untouched claim becomes stale only
  // when observed more than releaseOnInactivityHours later.
  const claimed = claimWork({ id: "w1" }, "quill");
  assert.deepEqual(staleClaims([claimed], { now: t0 }), []);
  assert.deepEqual(staleClaims([claimed], { now: t0 + 30 * hour }).map(item => item.id), ["w1"]);
  // event-model shape (src/events.js): updatedAt / claim.acquiredAt drive inactivity.
  const old = { id: "e-old", state: "working", updatedAt: iso(t0 - 30 * hour),
    claim: { holderId: "quill", status: "active", acquiredAt: iso(t0 - 30 * hour) } };
  const fresh = { id: "e-fresh", state: "working", updatedAt: iso(t0 - 2 * hour),
    claim: { holderId: "quill", status: "active", acquiredAt: iso(t0 - 2 * hour) } };
  const released = { id: "e-rel", state: "working", updatedAt: iso(t0 - 30 * hour),
    claim: { holderId: "quill", status: "released", acquiredAt: iso(t0 - 30 * hour) } };
  const doneOld = { id: "e-done", state: "completed", updatedAt: iso(t0 - 100 * hour),
    claim: { holderId: "quill", status: "active", acquiredAt: iso(t0 - 100 * hour) } };
  assert.deepEqual(staleClaims([old, fresh, released, doneOld], { now: t0 }).map(item => item.id), ["e-old"]);
  // The room's own releaseOnInactivityHours override is honored.
  assert.deepEqual(staleClaims([old], { norms: { releaseOnInactivityHours: 72 }, now: t0 }), []);
  assert.deepEqual(staleClaims([old], { norms: { releaseOnInactivityHours: 12 }, now: t0 }).map(item => item.id), ["e-old"]);
});

test("event-model claims (src/events.js shape) are understood", () => {
  const hour = 60 * 60 * 1000;
  const now = Date.parse("2026-09-18T12:00:00.000Z");
  const oldIso = new Date(now - 30 * hour).toISOString();
  const held = { id: "e1", state: "working", updatedAt: oldIso,
    claim: { holderId: "quill", status: "active", acquiredAt: oldIso } };
  const released = { id: "e2", state: "working", updatedAt: oldIso,
    claim: { holderId: "quill", status: "released", acquiredAt: oldIso, releasedAt: oldIso } };
  throwsCode(() => assertClaimAllowed([held], "quill"), "norm_claim_limit");
  assert.equal(assertClaimAllowed([released], "quill"), 0);
  assert.deepEqual(staleClaims([held, released], { now }).map(item => item.id), ["e1"]);
});

test("no-op-wake guidance stops polling after N consecutive no-op cycles", () => {
  assert.equal(shouldStopWaking(4), false);
  assert.equal(shouldStopWaking(5), true);
  assert.equal(shouldStopWaking(9), true);
  assert.equal(shouldStopWaking(2, { norms: { stopAfterRepeatedNoopWakes: 2 } }), true);
  assert.equal(shouldStopWaking(1, { norms: { stopAfterRepeatedNoopWakes: 2 } }), false);
  throwsCode(() => shouldStopWaking(-1), "norms_invalid_input");
  throwsCode(() => shouldStopWaking(1.5), "norms_invalid_input");
});

test("coordinationNormsBlock is the activation-pack JSON shape", () => {
  const id = room("pack");
  assert.deepEqual(coordinationNormsBlock(id), { coordinationNorms: {
    maxClaimsPerAgentPerCycle: 1, releaseOnInactivityHours: 24, stopAfterRepeatedNoopWakes: 5, customized: false } });
  setRoomNorms(id, { releaseOnInactivityHours: 12 }, { isOwner: true });
  assert.deepEqual(coordinationNormsBlock(id), { coordinationNorms: {
    maxClaimsPerAgentPerCycle: 1, releaseOnInactivityHours: 12, stopAfterRepeatedNoopWakes: 5, customized: true } });
  assert.ok(Object.isFrozen(coordinationNormsBlock(id).coordinationNorms));
});
