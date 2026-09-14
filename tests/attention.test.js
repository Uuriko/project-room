// W4-46 H4: quiet hours and digest choice over the wake queue's delivery.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { RoomStore } from "../server/store.mjs";
import { surfaceClass } from "../server/action-classes.mjs";

const HOUR = 3600000;
function fixture(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const d0 = Date.UTC(2026, 8, 14, 0, 0, 0); let at = d0 + 12 * HOUR; // start at noon UTC
  f.store.now = () => at; f.at = () => at; f.set = h => { at = d0 + h * HOUR; }; f.advance = ms => { at += ms; };
  f.prefs = (extra = {}, actor = "owner") => f.store.attention.mutate(f.keys[actor], "commons",
    { requestId: randomUUID(), quietStart: null, quietEnd: null, delivery: "immediate", digestHour: null, ...extra });
  f.enqueue = (extra = {}) => f.store.wakeQueue.enqueue(f.keys.owner, "commons",
    { requestId: randomUUID(), queueKey: "recipe:draft-catch-up", intent: { recipe: "draft-catch-up" }, dueAt: at, maxAttempts: 3, ...extra });
  f.deliverable = (actor = "owner") => f.store.attention.deliverable(f.keys[actor], "commons");
  return f;
}

test("delivery preferences validate exactly and retry idempotently", t => {
  const f = fixture(t);
  for (const change of [{ quietStart: 1.5 }, { quietStart: 1440 }, { quietStart: 22 * 60 }, { delivery: "loud" }, { delivery: "digest" }, { digestHour: 9 }, { digestHour: 24 }]) {
    assert.throws(() => f.prefs(change), "mismatched or out-of-range settings refuse");
  }
  const first = f.prefs({ quietStart: 22 * 60, quietEnd: 7 * 60 });
  assert.equal(first.duplicate, false);
  assert.deepEqual(f.store.attention.list(f.keys.owner, "commons").preferences.quietStart, 22 * 60);
  const retry = f.store.attention.mutate(f.keys.owner, "commons",
    { requestId: first.receipt.requestId, quietStart: 22 * 60, quietEnd: 7 * 60, delivery: "immediate", digestHour: null });
  assert.equal(retry.duplicate, true);
  assert.throws(() => f.store.attention.mutate(f.keys.owner, "commons",
    { requestId: first.receipt.requestId, quietStart: 21 * 60, quietEnd: 7 * 60, delivery: "immediate", digestHour: null }), { code: "idempotency_conflict" });
  assert.equal(f.store.attention.list(f.keys.guest, "commons").preferences, null, "preferences are private per member");
  const snap = f.store.snapshot(f.keys.owner, "commons");
  f.prefs({ quietStart: null, quietEnd: null });
  assert.equal(f.store.snapshot(f.keys.owner, "commons").sequence, snap.sequence, "preference changes append no room events");
});

test("quiet hours hold due wakes until the window ends, across midnight", t => {
  const f = fixture(t);
  f.prefs({ quietStart: 22 * 60, quietEnd: 7 * 60 });
  f.set(23); f.enqueue();
  const held = f.deliverable();
  assert.equal(held.deliverNow.length, 0); assert.equal(held.held.length, 1);
  assert.equal(held.held[0].heldUntil, f.at() + 8 * HOUR, "held until 07:00 the next morning");
  assert.equal(held.held[0].state, "pending", "held delivery stays pending - never marked handled");
  f.advance(8 * HOUR);
  const released = f.deliverable();
  assert.equal(released.deliverNow.length, 1); assert.equal(released.held.length, 0);
  assert.equal(released.heldUntil, null);
});

test("digest choice batches attention to the chosen hour; quiet hours still win", t => {
  const f = fixture(t);
  f.set(8); f.prefs({ delivery: "digest", digestHour: 9 });
  f.enqueue();
  assert.equal(f.deliverable().held[0].heldUntil, f.at() + HOUR, "before the digest hour, held until it");
  f.advance(HOUR);
  assert.equal(f.deliverable().deliverNow.length, 1, "at the digest hour, delivery flows");
  f.advance(2 * HOUR); f.enqueue({ queueKey: "recipe:suggest-next", intent: { recipe: "suggest-next" } });
  assert.equal(f.deliverable().held[0].heldUntil, f.at() + 22 * HOUR, "after the digest hour, held until tomorrow's");
  f.prefs({ quietStart: 8 * 60, quietEnd: 9 * 60 + 30, delivery: "digest", digestHour: 9, requestId: randomUUID() });
  f.set(8, 0);
  assert.equal(f.deliverable().held[0].heldUntil, f.at() + 90 * 60000, "a digest boundary inside quiet hours moves to the window end");
});

test("done-when: held delivery never changes canonical work or marks intent handled", t => {
  const f = fixture(t);
  f.prefs({ quietStart: 22 * 60, quietEnd: 7 * 60 });
  const before = f.store.snapshot(f.keys.owner, "commons");
  f.set(23); f.enqueue();
  const held = f.deliverable();
  assert.equal(held.held.length, 1);
  const after = f.store.snapshot(f.keys.owner, "commons");
  assert.equal(after.sequence, before.sequence, "no room events from prefs, enqueue or delivery views");
  assert.deepEqual(after.state.workItems, before.state.workItems, "canonical work is untouched");
  const row = f.store.db.prepare("SELECT state,attempts FROM wake_queue WHERE room_id='commons' AND queue_key='recipe:draft-catch-up'").get();
  assert.equal(row.state, "pending"); assert.equal(row.attempts, 0, "a held wake was never attempted or completed");
  // restart keeps both the intent and the preference
  f.store.close();
  f.store = new RoomStore(join(f.directory, "room.sqlite"), { now: () => f.at() });
  assert.equal(f.store.wakeQueue.list(f.keys.owner, "commons").wakes.length, 1);
  assert.equal(f.store.attention.list(f.keys.owner, "commons").preferences.quietStart, 22 * 60);
  assert.equal(surfaceClass("attention-delivery"), "draft");
});
