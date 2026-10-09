// F9: flood-guard burst — exactly capacity allowed, then 429 with Retry-After; refill over time.
import assert from "node:assert/strict";
import { createRoomFloodGuard } from "../../server/room-flood-guard.mjs";
import { fuzz } from "./lib.mjs";

fuzz("F9-flood-burst", async () => {
  let t = 1_000_000;
  const g = createRoomFloodGuard({ now: () => t });
  let allowed = 0, denied = 0, retryAfter = null;
  for (let i = 0; i < 100; i++) {
    try { g.consume("room1", "mallory", "message.posted"); allowed++; }
    catch (e) {
      denied++;
      assert.equal(e.status, 429, `expected 429, got ${e.status}`);
      retryAfter ??= e.headers?.["Retry-After"];
    }
  }
  assert.equal(allowed, 30, `burst allowed ${allowed}, want exactly 30`);
  assert.equal(denied, 70);
  assert.ok(Number(retryAfter) >= 1, `Retry-After missing/too small: ${retryAfter}`);
  console.log(`  burst: 30 allowed, 70 denied, Retry-After=${retryAfter}s`);

  // per-(room,member) isolation: another member unaffected
  g.consume("room1", "alice", "message.posted");

  // non-chat commands never spend
  for (let i = 0; i < 100; i++) g.consume("room1", "mallory", "reaction.added");
  console.log("  non-chat commands spend nothing");

  // refill: 0.5/s -> after 60s the bucket is full again
  t += 60_000;
  let allowed2 = 0;
  for (let i = 0; i < 40; i++) {
    try { g.consume("room1", "mallory", "message.posted"); allowed2++; } catch { break; }
  }
  assert.equal(allowed2, 30, `after refill allowed ${allowed2}, want 30`);
  console.log("  refill after 60s: bucket full again");

  // empty/garbage ids are ignored, never throw, never share a bucket that matters
  for (const [r, m] of [["", "x"], ["x", ""], [null, "x"], ["x", null], [123, 456]]) {
    g.consume(r, m, "message.posted");
  }
  console.log("  garbage ids ignored without throw");
});
