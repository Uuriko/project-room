// LANE B: scheduled-send store tests (fixture-driven, injected clock).
import test from "node:test";
import assert from "node:assert/strict";
import { createSendLaterStore, SendLaterError, UNDO_WINDOW_MS } from "../server/inbox-send-later.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof SendLaterError && error.code === code);

const NOW = 1_750_000_000_000;
const makeClock = () => {
  let now = NOW;
  const clock = () => now;
  clock.advance = ms => { now += ms; };
  return clock;
};
const message = (id = "m1") => ({ id, subject: "hello" });

test("schedule/cancel/list lifecycle", () => {
  const store = createSendLaterStore({ clock: makeClock() });
  const first = store.schedule(message("m1"), { sendAt: NOW + 3600_000 });
  const second = store.schedule(message("m2"), { sendAt: NOW + 7200_000 });
  assert.equal(first.state, "scheduled");
  assert.equal(second.state, "scheduled");
  assert.ok(first.id !== second.id);
  assert.equal(store.list().length, 2);
  assert.equal(store.list({ state: "scheduled" }).length, 2);
  const cancelled = store.cancel(first.id, { reason: "changed my mind" });
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.cancelReason, "changed my mind");
  assert.equal(store.list({ state: "cancelled" }).length, 1);
  assert.deepEqual(store.counts(), { scheduled: 1, ready: 0, sent: 0, failed: 0, cancelled: 1, draft: 0 });
});

test("schedule validation", () => {
  const clock = makeClock();
  const store = createSendLaterStore({ clock });
  throwsCode(() => store.schedule(message(), { sendAt: NOW - 1 }), "SL_INVALID_INPUT"); // past
  throwsCode(() => store.schedule(message(), { sendAt: NOW }), "SL_INVALID_INPUT"); // not future
  throwsCode(() => store.schedule(message(), { sendAt: NOW + 366 * 86400_000 }), "SL_INVALID_INPUT"); // horizon
  throwsCode(() => store.schedule(null, { sendAt: NOW + 1000 }), "SL_INVALID_INPUT");
  throwsCode(() => store.schedule({ id: "" }, { sendAt: NOW + 1000 }), "SL_INVALID_INPUT");
  throwsCode(() => store.schedule(message(), { sendAt: "later" }), "SL_INVALID_INPUT");
  const a = store.schedule(message(), { sendAt: NOW + 1000, id: "fixed" });
  assert.equal(a.id, "fixed");
  throwsCode(() => store.schedule(message(), { sendAt: NOW + 1000, id: "fixed" }), "SL_DUPLICATE_ID");
});

test("due sweep + take + complete: no double-send", () => {
  const clock = makeClock();
  const store = createSendLaterStore({ clock });
  store.schedule(message("old"), { sendAt: NOW + 1000 });
  store.schedule(message("newer"), { sendAt: NOW + 2000 });
  store.schedule(message("future"), { sendAt: NOW + 99_000_000 });
  assert.equal(store.due().length, 0);
  clock.advance(5000);
  const due = store.due();
  assert.deepEqual(due.map(r => r.message.id), ["old", "newer"]); // oldest first
  // take claims them: still due-excluded (no longer 'scheduled')
  const taken = store.take(due.map(r => r.id));
  assert.ok(taken.every(r => r.state === "ready"));
  assert.equal(store.due().length, 0);
  // take is idempotent for already-claimed ids
  assert.equal(store.take([taken[0].id])[0].state, "ready");
  const sent = store.complete(taken[0].id);
  assert.equal(sent.state, "sent");
  assert.equal(sent.sentAt, NOW + 5000);
  // cannot take/cancel a sent record
  throwsCode(() => store.take([taken[0].id]), "SL_BAD_TRANSITION");
  throwsCode(() => store.cancel(taken[0].id), "SL_BAD_TRANSITION");
  // complete requires claimed state
  assert.equal(store.complete(taken[1].id).state, "sent");
});

test("complete requires the ready state", () => {
  const store = createSendLaterStore({ clock: makeClock() });
  const s = store.schedule(message(), { sendAt: NOW + 1000 });
  throwsCode(() => store.complete(s.id), "SL_BAD_TRANSITION");
  throwsCode(() => store.failSend(s.id), "SL_BAD_TRANSITION");
  const f = store.schedule(message("f"), { sendAt: NOW + 1000 });
  throwsCode(() => store.cancel(f.id, { reason: 42 }), "SL_INVALID_INPUT");
});

test("failSend marks failed with reason", () => {
  const clock = makeClock();
  const store = createSendLaterStore({ clock });
  const s = store.schedule(message(), { sendAt: NOW + 1000 });
  clock.advance(2000);
  store.take([s.id]);
  const failed = store.failSend(s.id, { reason: "smtp 550" });
  assert.equal(failed.state, "failed");
  assert.equal(failed.failReason, "smtp 550");
  throwsCode(() => store.failSend(s.id), "SL_BAD_TRANSITION");
});

test("undo inside the window pulls back to draft; after expiry it throws", () => {
  const clock = makeClock();
  const store = createSendLaterStore({ clock });
  const s = store.schedule(message(), { sendAt: NOW + 1000 });
  clock.advance(2000);
  store.take([s.id]);
  store.complete(s.id);
  clock.advance(UNDO_WINDOW_MS - 1);
  const undone = store.undo(s.id);
  assert.equal(undone.state, "draft");
  // undo only works on sent
  throwsCode(() => store.undo(s.id), "SL_BAD_TRANSITION");

  const clock2 = makeClock();
  const store2 = createSendLaterStore({ clock: clock2 });
  const t = store2.schedule(message(), { sendAt: NOW + 1000 });
  clock2.advance(2000);
  store2.take([t.id]);
  store2.complete(t.id);
  clock2.advance(UNDO_WINDOW_MS + 1);
  throwsCode(() => store2.undo(t.id), "SL_UNDO_EXPIRED");
  assert.equal(store2.get(t.id).state, "sent");
});

test("outputs are frozen; unknown ids throw", () => {
  const store = createSendLaterStore({ clock: makeClock() });
  const s = store.schedule(message(), { sendAt: NOW + 1000 });
  assert.ok(Object.isFrozen(s));
  assert.ok(Object.isFrozen(s.message));
  throwsCode(() => store.cancel("nope"), "SL_UNKNOWN_SCHEDULE");
  throwsCode(() => store.take(["nope"]), "SL_UNKNOWN_SCHEDULE");
  assert.equal(store.get("nope"), null);
  assert.equal(store.get(42), null);
  throwsCode(() => store.list({ state: "bogus" }), "SL_INVALID_INPUT");
});
