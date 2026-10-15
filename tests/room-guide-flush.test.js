// flushRoomGuide must keep a queued guide step queued when the step throws
// (issue #2953): the module contract is "A step that threw stays queued", and
// the command-hook path already deletes only after success. The flush runs
// in a finally after every Durable Object request, so dropping the entry on
// a transient failure would permanently lose the step.
import test from "node:test";
import assert from "node:assert/strict";
import { flushRoomGuide, installGuideCommandHook } from "../server/room-guide.mjs";

function makeFlakyStore() {
  let attempts = 0;
  let failing = true;
  // A fresh class per store: installGuideCommandHook patches the prototype.
  class FlakyStore {
    command() { return { ok: true }; }
  }
  const store = new FlakyStore();
  store.db = {};
  store.now = () => 1000;
  store.transaction = fn => fn();
  store.room = () => {
    attempts += 1;
    if (failing) throw new Error("transient guide failure");
    // No starterSeeded: a recovered step succeeds as a no-op (returns null).
    return { state: { room: {}, members: {} } };
  };
  return {
    store,
    attempts: () => attempts,
    recover: () => { failing = false; }
  };
}

test("flushRoomGuide retries a step that threw and clears it only after success", () => {
  const { store, attempts, recover } = makeFlakyStore();
  const originalError = console.error;
  console.error = () => {};
  try {
    installGuideCommandHook(store);
    // The command hook queues the room, the step throws, so it stays queued.
    store.command("token", "room-1", {}, null);
    assert.equal(attempts(), 1);

    // A flush whose step throws must not drop the queued step.
    flushRoomGuide(store);
    assert.equal(attempts(), 2, "flush attempts the queued step");

    // The next flush must retry the same step, not find an empty queue.
    flushRoomGuide(store);
    assert.equal(attempts(), 3, "a step that threw in flushRoomGuide stays queued for the next flush");

    // Once the step succeeds, the queue entry is cleared.
    recover();
    flushRoomGuide(store);
    assert.equal(attempts(), 4, "flush retries the queued step after recovery");
    flushRoomGuide(store);
    assert.equal(attempts(), 4, "a step that succeeded is no longer queued");
  } finally {
    console.error = originalError;
  }
});
