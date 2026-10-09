// Board bug (found 2026-10-06 by John's Tab): reassigning an UNCLAIMED item
// set the owner but left state "unclaimed" with no lease, so the item looked
// free to take, never expired and never showed as the assignee's claim.
// Reassign of an unclaimed item now hands it over as a claim with the room's
// default lease, the same shape create-with-assignee produces.
import test from "node:test";
import assert from "node:assert/strict";
import { createWork, claimWork, reassignWork, isLeaseExpired, releaseExpired, roomWorkClaimConfig } from "../server/work-claims.mjs";

const T0 = Date.parse("2026-10-06T05:00:00.000Z");
const H = 3600 * 1000;

test("reassigning an unclaimed item makes it a claim with the room default lease", () => {
  const item = createWork({ id: "u1", title: "Review it" }, { now: T0 });
  assert.equal(item.state, "unclaimed");
  const assigned = reassignWork(item, "lead", "instinct", { authority: true, now: T0 });
  assert.equal(assigned.owner, "instinct");
  assert.equal(assigned.state, "claimed");
  const hours = roomWorkClaimConfig(undefined).defaultLeaseHours;
  assert.equal(assigned.claimedAt, new Date(T0).toISOString());
  assert.equal(Date.parse(assigned.leaseExpiresAt) - T0, hours * H);
  assert.match(assigned.history.at(-1).action, /^reassigned/);
});

test("the room's configured default lease is used", () => {
  const item = createWork({ id: "u2", title: "Review it" }, { now: T0 });
  const assigned = reassignWork(item, "lead", "fo", { authority: true, now: T0, room: { workClaims: { defaultLeaseHours: 6 } } });
  assert.equal(Date.parse(assigned.leaseExpiresAt) - T0, 6 * H);
});

test("an assigned item expires and returns to the pool like any claim", () => {
  const item = createWork({ id: "u3", title: "Review it" }, { now: T0 });
  const assigned = reassignWork(item, "lead", "grok", { authority: true, now: T0, room: { workClaims: { defaultLeaseHours: 2 } } });
  assert.equal(isLeaseExpired(assigned, T0 + H), false);
  assert.equal(isLeaseExpired(assigned, T0 + 3 * H), true);
  const [released] = releaseExpired([assigned], T0 + 3 * H);
  assert.equal(released.state, "expired");
  assert.equal(released.owner, null);
});

test("reassigning a held claim keeps its state and current lease", () => {
  const claimed = claimWork(createWork({ id: "u4", title: "Build it" }, { now: T0 }), "quill", { now: T0, leaseHours: 4 });
  const moved = reassignWork(claimed, "quill", "instinct", { now: T0 + H });
  assert.equal(moved.state, "claimed");
  assert.equal(moved.owner, "instinct");
  assert.equal(moved.leaseExpiresAt, claimed.leaseExpiresAt);
  assert.equal(moved.claimedAt, claimed.claimedAt);
});
