import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_CLAIM_SEC, filterClaimedNeedsMe, clampClaimSec } from "../server/attention-claim.mjs";

function db() {
  return new DatabaseSync(":memory:");
}

test("clampClaimSec bounds and zeroes", () => {
  assert.equal(clampClaimSec(undefined), 0);
  assert.equal(clampClaimSec(0), 0);
  assert.equal(clampClaimSec(-1), 0);
  assert.equal(clampClaimSec(12.7), 12);
  assert.equal(clampClaimSec(9999), 300);
  assert.equal(DEFAULT_CLAIM_SEC, 45);
});

test("first handler leases; second is suppressed until expiry", () => {
  const database = db();
  const memberByRoom = new Map([["r1", "m1"]]);
  const items = [
    { roomId: "r1", kind: "direct_ask", id: "ask-1", seq: 1 },
    { roomId: "r1", kind: "mention", id: "msg-9", seq: 2 },
  ];
  const now = 1_700_000_000_000;
  const first = filterClaimedNeedsMe(database, { items, memberByRoom, claimSec: 45, now });
  assert.equal(first.leased, 2);
  assert.equal(first.suppressed, 0);
  assert.equal(first.items.length, 2);
  assert.ok(first.items[0].claimedUntil);

  const second = filterClaimedNeedsMe(database, { items, memberByRoom, claimSec: 45, now: now + 1_000 });
  assert.equal(second.leased, 0);
  assert.equal(second.suppressed, 2);
  assert.deepEqual(second.items, []);

  const after = filterClaimedNeedsMe(database, { items, memberByRoom, claimSec: 45, now: now + 46_000 });
  assert.equal(after.leased, 2);
  assert.equal(after.suppressed, 0);
  assert.equal(after.items.length, 2);
});

test("claimSec 0 is a no-op", () => {
  const database = db();
  const items = [{ roomId: "r1", kind: "mention", id: "m", seq: 1 }];
  const out = filterClaimedNeedsMe(database, {
    items, memberByRoom: new Map([["r1", "m1"]]), claimSec: 0, now: 1,
  });
  assert.equal(out.leaseSec, 0);
  assert.equal(out.leased, 0);
  assert.deepEqual(out.items, items);
});

test("items without a member mapping pass through", () => {
  const database = db();
  const items = [{ roomId: "other", kind: "mention", id: "m", seq: 1 }];
  const out = filterClaimedNeedsMe(database, {
    items, memberByRoom: new Map([["r1", "m1"]]), claimSec: 30, now: 1,
  });
  assert.equal(out.leased, 0);
  assert.equal(out.items.length, 1);
});

test("claimSec 0 return is alias-safe under clear-then-push", () => {
  const database = db();
  const items = [{ roomId: "r1", kind: "mention", id: "m", seq: 1 }];
  const out = filterClaimedNeedsMe(database, {
    items, memberByRoom: new Map([["r1", "m1"]]), claimSec: 0, now: 1,
  });
  items.length = 0;
  items.push(...out.items);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "m");
});
